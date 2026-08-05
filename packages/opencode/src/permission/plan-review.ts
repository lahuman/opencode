import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"

export type Decision = "allow" | "ask" | "deny"
export type Risk = "low" | "medium" | "high" | "critical"

export type ContextSeed = {
  agent: Agent.Info
  agentID: string
  model: Provider.Model
  userMessageID: SessionV1.MessageID
  assistantMessageID: SessionV1.MessageID
  callID: string
  directory: string
  abort: AbortSignal
}

export type Context = ContextSeed & {
  approvalMode: SessionV1.SessionInfo["approvalMode"]
  messages: ReadonlyArray<SessionV1.WithParts>
  rulesetDigest: string
}

export type LoadedContext = {
  context: Context
  ruleset: PermissionV1.Ruleset
}

export type ContextLoad = { type: "loaded"; value: LoadedContext } | { type: "missing" }

export type ContextInput = {
  seed: ContextSeed
  load: () => Effect.Effect<ContextLoad>
}

export type ReviewRequest = {
  id: PermissionV1.ID
  sessionID: SessionV1.SessionInfo["id"]
  permission: string
  patterns: ReadonlyArray<string>
  metadata: Readonly<Record<string, unknown>>
  always: ReadonlyArray<string>
  tool?: { readonly messageID: string; readonly callID: string }
}

export type PolicyInput = {
  request: ReviewRequest
  context: Context
}

export type Finding = {
  category: "read_only" | "validation" | "scope"
  risk: "low" | "medium"
  code: "read_only_inspection" | "focused_validation" | "workspace_local" | "scope_requires_caution"
}

export type Guard = { type: "pass" } | { type: "deny"; reason: string; alternative?: string }

type Preflight =
  | { type: "review"; findings: readonly Finding[] }
  | { type: "ask"; review: PermissionV1.Review }
  | { type: "deny"; reason: string; alternative?: string }

const MANUAL: Preflight = {
  type: "ask",
  review: { risk: "medium", reason: "This request needs manual review." },
}
const MUTATION = {
  type: "deny" as const,
  reason: "Plan mode cannot modify files.",
  alternative: "Switch to Build mode to make changes.",
}
const HAZARD = {
  type: "deny" as const,
  reason: "Plan mode cannot perform mutating or hazardous operations.",
  alternative: "Switch to Build mode to make changes.",
}

const CREDENTIAL_PATH =
  /(?:^|[\s"'\\/])(?:\.env[^\s"'\\/]*|\.npmrc|\.yarnrc[^\s"'\\/]*|\.pypirc|\.netrc|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|application_default_credentials\.json|[^\s"'\\/]*service[-_]?account[^\s"'\\/]*\.json|\.azure[\\/](?:accessTokens|azureProfile|msal_token_cache)[^\s"'\\/]*\.json|\.ssh[\\/][^\s"'\\/]+|\.aws[\\/](?:credentials|config))(?=$|[\s"'\\/])|[\\/]proc[\\/][^\\/]+[\\/]environ(?:$|[\\/])/i
const CREDENTIAL_COMMAND =
  /^(?:env|printenv|set|export\s+-p|(?:Get-ChildItem|gci|dir)\s+Env:|git\s+credential\s+fill|gh\s+auth\s+token|npm\s+config\s+get\s+\S*(?:auth|token|password)\S*|gcloud\s+auth\s+print-access-token|az\s+account\s+get-access-token|aws\s+configure\s+get|kubectl\s+config\s+view\b[^\r\n]*\s--raw)(?:\s|$)/i
const CREDENTIAL_NAME = /(?:token|secret|password|api[_-]?key|authorization|credential)/i

export function sensitiveText(value: string) {
  return (
    CREDENTIAL_PATH.test(value) ||
    CREDENTIAL_COMMAND.test(value.trim()) ||
    (/(?:\$\{?|%|\$env:)[A-Za-z_][A-Za-z0-9_]*(?:\}?%?)/i.test(value) && CREDENTIAL_NAME.test(value))
  )
}

export const guard = (input: PolicyInput): Effect.Effect<Guard> =>
  Effect.succeed(["edit", "write", "apply_patch"].includes(input.request.permission) ? MUTATION : { type: "pass" })

export const preflight = (input: PolicyInput): Effect.Effect<Preflight> =>
  Effect.gen(function* () {
    const guarded = yield* guard(input)
    if (guarded.type === "deny") return guarded
    if (input.request.permission === "todowrite") {
      return { type: "review", findings: [{ category: "scope", risk: "low", code: "workspace_local" }] }
    }
    if (input.request.permission === "external_directory") return MANUAL
    if (input.request.permission !== "bash") return MANUAL

    const metadata = shellMetadata(input.request.metadata)
    if (!metadata || !metadata.parsed) return MANUAL
    if (sensitiveText(metadata.command)) return MANUAL
    if (hasCwdTransition(metadata.command)) return MANUAL
    if (scopeLocation(metadata.cwd, input.context.directory) !== "inside") return MANUAL

    const results: Preflight[] = []
    for (const pattern of input.request.patterns) {
      if (sensitiveText(pattern)) {
        results.push(MANUAL)
        continue
      }
      const deterministic = classify(pattern)
      if (deterministic !== "review") {
        results.push(deterministic === "deny" ? HAZARD : MANUAL)
        continue
      }
      const scope = scopeTarget(pattern, metadata.cwd, input.context.directory, metadata.shell)
      if (scope !== "inside") {
        results.push(MANUAL)
        continue
      }
      results.push({
        type: "review",
        findings: [
          {
            category: validation(pattern) ? "validation" : "read_only",
            risk: "low",
            code: validation(pattern) ? "focused_validation" : "read_only_inspection",
          },
          { category: "scope", risk: "low", code: "workspace_local" },
        ],
      })
    }

    if (results.some((result) => result.type === "deny")) return HAZARD
    if (results.length === 0 || results.some((result) => result.type === "ask")) return MANUAL
    return { type: "review", findings: results.flatMap((result) => (result.type === "review" ? result.findings : [])) }
  })

export const normalize = (input: PolicyInput): Effect.Effect<string> =>
  Effect.succeed(
    canonical({
      request: input.request,
      directory: path.resolve(input.context.directory),
      rulesetDigest: input.context.rulesetDigest,
      targets: input.request.patterns.map((pattern) =>
        targetFact(pattern, input.request.metadata.cwd, input.request.metadata.shell),
      ),
    }),
  )

export const rulesetDigest = (ruleset: PermissionV1.Ruleset) =>
  new Bun.CryptoHasher("sha256").update(canonical(ruleset)).digest("hex")

export function decisionAllowed(decision: Decision, risk: Risk) {
  if (risk === "low") return decision === "allow" || decision === "ask"
  if (risk === "medium") return decision === "ask"
  return decision === "ask" || decision === "deny"
}

function shellMetadata(
  metadata: Readonly<Record<string, unknown>>,
): { command: string; shell: "bash" | "powershell" | "cmd"; parsed: boolean; cwd: string } | undefined {
  if (typeof metadata.command !== "string") return
  const shell = metadata.shell
  if (shell !== "bash" && shell !== "powershell" && shell !== "cmd") return
  if (typeof metadata.parsed !== "boolean") return
  if (typeof metadata.cwd !== "string" || !path.isAbsolute(metadata.cwd)) return
  return {
    command: metadata.command,
    shell,
    parsed: metadata.parsed,
    cwd: path.normalize(metadata.cwd),
  }
}

function hasCwdTransition(command: string) {
  if (!/(?:&&|\|\||[;&|()]|\r|\n)/.test(command)) return false
  return /(?:^|[;&|()]|\s)(?:cd|chdir|pushd|popd|Set-Location|sl)(?:\s|$)/i.test(command)
}

function classify(pattern: string): "review" | "ask" | "deny" {
  const text = pattern.trim()
  if (!text) return "ask"
  if (/\s(?:>|>>)(?:\s|$)|(?:>|>>)\s*\S/.test(text)) return "deny"
  if (/(?:^|\s)(?:tee|Tee-Object|Out-File)(?:\s|$)/i.test(text)) return "deny"
  if (
    /^(?:rm\s+-[^\r\n]*r|Remove-Item\b[^\r\n]*-Recurse|del\s+\/s|format(?:\s|$)|git\s+(?:reset\s+--hard|clean\b))/i.test(
      text,
    )
  )
    return "deny"
  if (
    /^(?:touch|mkdir|md|rd|rmdir|Set-Content|Add-Content|New-Item|Rename-Item|Move-Item|Copy-Item|Remove-Item|cp|mv|move|copy|ren|rename)(?:\s|$)/i.test(
      text,
    )
  )
    return "deny"
  if (/^sed\b[^\r\n]*\s-i(?:\s|$)/i.test(text)) return "deny"
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|upgrade)(?:\s|$)/i.test(text)) return "deny"
  if (
    /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:generate|codegen|build)(?:\s|$)|^(?:go|prisma)\s+generate(?:\s|$)/i.test(
      text,
    )
  )
    return "deny"
  if (
    /^(?:vercel|netlify|wrangler|terraform|pulumi)\s+(?:deploy|apply|destroy|publish)(?:\s|$)|^kubectl\s+(?:apply|create|delete|patch|replace|set)(?:\s|$)|^helm\s+(?:install|upgrade|uninstall|rollback)(?:\s|$)|^docker\s+(?:push|login)(?:\s|$)|^aws\s+s3\s+(?:cp|mv|rm|sync)(?:\s|$)/i.test(
      text,
    )
  )
    return "deny"
  if (/^(?:sudo|su|runas)(?:\s|$)|^(?:Set-ExecutionPolicy|chmod|chown)(?:\s|$)/i.test(text)) return "deny"
  if (
    /^wget(?:\s|$)|^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\b[^\r\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|-Method\s+(?:Post|Put|Patch|Delete)|--upload-file|-T\s|(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-o|--output|-OutFile)(?:\s|=))/i.test(
      text,
    )
  )
    return "deny"
  if (
    /^find\b[^\r\n]*(?:\s-delete(?:\s|$)|\s-(?:exec|execdir|ok|okdir)\s+\S*(?:rm|mv|cp|touch|mkdir|chmod|chown|sed)\b)/i.test(
      text,
    )
  )
    return "deny"
  if (/^find\b[^\r\n]*\s-(?:exec|execdir|ok|okdir)(?:\s|$)/i.test(text)) return "ask"
  if (/(?:^|\s)(?:--fix|--write|--update-snapshots|-u)(?:\s|$)/i.test(text)) return "deny"
  if (/^(?:curl|Invoke-WebRequest|Invoke-RestMethod|scp|sftp|rsync)(?:\s|$)/i.test(text)) return "ask"
  if (/(?:encodedcommand|frombase64string|base64\s+-d)/i.test(text)) return "ask"
  if (/^(?:alias|function|Set-Alias|New-Alias)(?:\s|$)/i.test(text)) return "ask"
  if (/[$`%]|[?*[]/.test(text)) return "ask"
  if (/[{},]|@\(/.test(text)) return "ask"
  if (/[<|]/.test(text)) return "ask"

  if (/^git(?:\s|$)/i.test(text)) return classifyGit(text)
  if (
    /^bun\s+typecheck(?:\s|$)|^bun\s+test\s+(?!-)(?:test[\\/]|[^\s]+\.(?:test|spec)\.)|^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:typecheck|lint)(?:\s|$)|^(?:npm|pnpm|yarn)\s+test\s+\S+|^cargo\s+(?:test\s+\S+|check(?:\s|$))|^go\s+test\s+\S+/i.test(
      text,
    )
  )
    return "review"
  if (
    /^(?:cat|type|Get-Content|ls|dir|Get-ChildItem|find|fd|rg|grep|head|tail|stat|Test-Path|pwd|Get-Location|echo|Write-Output|Write-Host)(?:\s|$)/i.test(
      text,
    )
  )
    return "review"
  return "ask"
}

function classifyGit(pattern: string): "review" | "ask" | "deny" {
  const text = pattern.replace(/^git\s+/i, "").trim()
  if (/^(?:status|log|show|blame|rev-parse|ls-files|ls-tree|cat-file)(?:\s|$)/i.test(text)) return "review"
  if (/^diff\b[^\r\n]*(?:--output(?:=|\s)|--no-index\b[^\r\n]*\s--output(?:=|\s))/i.test(text)) return "deny"
  if (/^diff(?:\s|$)/i.test(text)) return "review"
  if (
    /^branch\s*$|^branch\s+(?:-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--list|-l)$|^branch\s+(?:--contains|--merged|--no-merged)(?:\s+\S+)?$/i.test(
      text,
    )
  )
    return "review"
  if (/^tag\s*$|^tag\s+(?:-n|-l|--list)$|^tag\s+(?:--contains|--points-at)(?:\s+\S+)?$/i.test(text)) return "review"
  if (
    /^stash\s+list(?:\s|$)|^worktree\s+list(?:\s|$)|^config\s+(?:--get|--get-all|--list|-l\b)(?:\s|$)|^remote(?:\s*$|\s+-v(?:\s|$)|\s+get-url(?:\s|$))/i.test(
      text,
    )
  )
    return "review"
  if (
    /^(?:add|rm|mv|apply|am|revert|init|clone|fetch|pull|push|reset|checkout|switch|restore|commit|merge|rebase|cherry-pick|update-index)(?:\s|$)/i.test(
      text,
    )
  )
    return "deny"
  if (
    /^config\s+(?:--\S+\s+)*\S+\s+\S+|^remote\s+(?:add|remove|rename|set-url|prune|update)(?:\s|$)|^submodule\s+update(?:\s|$)|^sparse-checkout(?:\s|$)|^bisect(?:\s|$)|^stash(?:\s|$)|^worktree\s+(?:add|remove|move)(?:\s|$)/i.test(
      text,
    )
  )
    return "deny"
  if (/^clean(?:\s|$)/i.test(text)) return "deny"
  if (/^branch\b[^\r\n]*(?:\s-D?\s|\s--delete\s)|^tag\b[^\r\n]*(?:\s-d\s|\s--delete\s)/i.test(text)) return "deny"
  if (/^(?:branch|tag)\s+-/i.test(text)) return "ask"
  if (/^(?:branch|tag)\s+\S+/i.test(text)) return "deny"
  return "ask"
}

function validation(pattern: string) {
  return /^(?:bun\s+(?:test|typecheck)|npm\s+(?:test|run\s+(?:test|typecheck|lint))|pnpm\s+(?:test|typecheck|lint)|yarn\s+(?:test|typecheck|lint)|cargo\s+(?:test|check)|go\s+test)(?:\s|$)/i.test(
    pattern,
  )
}

function scopeTarget(
  pattern: string,
  cwd: string,
  boundary: string,
  shell: "bash" | "powershell" | "cmd",
): "inside" | "outside" | "uncertain" {
  const scan = targetValues(pattern, shell)
  if (scan.type === "none") return "inside"
  if (scan.type === "uncertain") return "uncertain"
  const root = canonicalTarget(boundary)
  if (!root) return "uncertain"
  for (const value of scan.values) {
    const target = resolveTarget(value, cwd)
    if (!target) return "uncertain"
    if (!FSUtil.contains(root, target)) return "outside"
  }
  return "inside"
}

function targetFact(pattern: string, cwd: unknown, shell: unknown) {
  if (shell !== "bash" && shell !== "powershell" && shell !== "cmd") return { type: "uncertain" }
  const scan = targetValues(pattern, shell)
  if (scan.type !== "targets") return scan
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return { type: "uncertain" }
  const targets = scan.values.map((value) => resolveTarget(value, cwd))
  return targets.every((target): target is string => Boolean(target))
    ? { type: "resolved", targets }
    : { type: "uncertain" }
}

type TargetScan = { type: "none" } | { type: "uncertain" } | { type: "targets"; values: string[] }

function targetValues(pattern: string, shell: "bash" | "powershell" | "cmd"): TargetScan {
  const tokens = tokenize(pattern)
  if (!tokens?.length) return { type: "uncertain" }
  const command = tokens[0].toLowerCase()
  const option = (value: string) => value.startsWith("-") || (shell === "cmd" && /^\/[A-Za-z]+$/.test(value))

  if (
    ["cat", "type", "get-content", "head", "tail", "stat", "test-path", "ls", "dir", "get-childitem"].includes(command)
  ) {
    const values = tokens.slice(1).filter((value) => !option(value))
    return values.length ? { type: "targets", values } : { type: "uncertain" }
  }
  if (["rg", "grep", "fd"].includes(command)) {
    if (tokens.slice(1).some(option)) return { type: "uncertain" }
    if (tokens.length < 2) return { type: "uncertain" }
    return tokens.length === 2 ? { type: "none" } : { type: "targets", values: tokens.slice(2) }
  }
  if (command === "find") {
    const expression = tokens.findIndex(
      (value, index) => index > 0 && (value.startsWith("-") || value === "!" || value === "("),
    )
    const values = expression === -1 ? tokens.slice(1) : tokens.slice(1, expression)
    return values.length ? { type: "targets", values } : { type: "none" }
  }
  if (command === "git" && tokens[1]?.toLowerCase() === "diff") {
    const separator = tokens.indexOf("--")
    if (separator !== -1) {
      return tokens.length > separator + 1
        ? { type: "targets", values: tokens.slice(separator + 1) }
        : { type: "uncertain" }
    }
    if (tokens.includes("--no-index")) {
      const values = tokens.slice(2).filter((value) => !option(value))
      return values.length === 2 ? { type: "targets", values } : { type: "uncertain" }
    }
    return tokens.slice(2).some((value) => !option(value)) ? { type: "uncertain" } : { type: "none" }
  }
  return { type: "none" }
}

function tokenize(value: string) {
  const tokens: string[] = []
  const expression = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  let end = 0
  for (const match of value.matchAll(expression)) {
    if (value.slice(end, match.index).trim()) return
    if (match[3]?.includes('"') || match[3]?.includes("'")) return
    tokens.push(match[1] ?? match[2] ?? match[3])
    end = match.index + match[0].length
  }
  if (value.slice(end).trim()) return
  return tokens
}

function resolveTarget(value: string, cwd: string) {
  if (!value || value === "-" || /::/.test(value) || /^(?![A-Za-z]:)[A-Za-z]+:/.test(value)) return
  return canonicalTarget(path.resolve(cwd, FSUtil.windowsPath(value)))
}

function scopeLocation(value: string, boundary: string): "inside" | "outside" | "uncertain" {
  const target = canonicalTarget(value)
  const root = canonicalTarget(boundary)
  if (!target || !root) return "uncertain"
  return FSUtil.contains(root, target) ? "inside" : "outside"
}

function canonicalTarget(input: string) {
  const normalized = path.resolve(input)
  try {
    if (existsSync(normalized)) return FSUtil.normalizePath(realpathSync.native(normalized))
    if (lstatSync(normalized, { throwIfNoEntry: false })) return
    const missing: string[] = []
    let current = normalized
    while (!existsSync(current)) {
      if (lstatSync(current, { throwIfNoEntry: false })) return
      const parent = path.dirname(current)
      if (parent === current) return
      missing.unshift(path.basename(current))
      current = parent
    }
    return path.join(FSUtil.normalizePath(realpathSync.native(current)), ...missing)
  } catch {
    return
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return "null"
}
