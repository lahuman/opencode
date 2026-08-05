import type { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { LLMRequestPrep } from "@/session/llm/request"
import { isRecord } from "@/util/record"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Hash } from "@opencode-ai/core/util/hash"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { OtelTracer } from "@effect/opentelemetry/Tracer"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { generateObject, NoObjectGeneratedError, streamObject, type ModelMessage } from "ai"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { types } from "node:util"

import REVIEW_POLICY from "./plan-review.txt"

export { REVIEW_POLICY }

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

export type ReviewContext = ContextSeed & {
  approvalMode: SessionV1.SessionInfo["approvalMode"]
  messages: ReadonlyArray<SessionV1.WithParts>
  rulesetDigest: string
}

export type LoadedContext = {
  context: ReviewContext
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

const ReviewRequestSchema = Schema.Struct({
  id: PermissionV1.ID,
  sessionID: SessionV1.SessionInfo.fields.id,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String })),
})

export type PolicyInput = {
  request: ReviewRequest
  context: ReviewContext
}

export type { ReviewContext as Context }

export type Finding = {
  category: "read_only" | "validation" | "scope"
  risk: "low" | "medium"
  code: "read_only_inspection" | "focused_validation" | "workspace_local" | "scope_requires_caution"
}

export type Guard = { type: "pass" } | { type: "deny"; reason: string; alternative?: string }

export type Outcome =
  | { type: "allow" }
  | { type: "ask"; review: PermissionV1.Review }
  | { type: "manual" }
  | { type: "configured_deny" }
  | { type: "read_only"; reason: string; alternative?: string }
  | { type: "deny"; reason: string; alternative?: string }
  | { type: "cancel" }

export type ReviewInput = PolicyInput & {
  findings: readonly Finding[]
  isActive: () => Effect.Effect<boolean>
}

export interface Interface {
  readonly review: (input: ReviewInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PlanReview") {}

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
const FALLBACK_REVIEW: PermissionV1.Review = {
  risk: "medium",
  reason: "This request needs manual review.",
}

const ReviewText = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(240),
  Schema.makeFilter((value) =>
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? "control characters are not allowed" : undefined,
  ),
)
const Output = Schema.Struct({
  decision: Schema.Literals(["allow", "ask", "deny"]),
  risk: PermissionV1.ReviewRisk,
  reason: ReviewText,
  alternative: Schema.optional(ReviewText),
})
type Output = typeof Output.Type

const CREDENTIAL_PATH =
  /(?:^|[\s"'\\/])(?:\.env[^\s"'\\/]*|\.npmrc|\.yarnrc[^\s"'\\/]*|\.pypirc|\.netrc|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|application_default_credentials\.json|[^\s"'\\/]*service[-_]?account[^\s"'\\/]*\.json|\.azure[\\/](?:accessTokens|azureProfile|msal_(?:token|http)_cache)[^\s"'\\/]*(?:\.json|\.bin)?|\.config[\\/]gh[\\/]hosts\.yml|\.ssh[\\/][^\s"'\\/]+|\.aws[\\/](?:credentials|config))(?=$|[\s"'\\/])|[\\/]proc[\\/][^\\/]+[\\/]environ(?:$|[\\/])/i
const CREDENTIAL_COMMAND =
  /^(?:env|printenv|set|export\s+-p|(?:Get-ChildItem|gci|dir)\s+Env:|git\s+credential\s+fill|gh\s+auth\s+token|npm\s+config\s+get\s+\S*(?:auth|token|password)\S*|gcloud\s+auth\s+print-access-token|az\s+account\s+get-access-token|aws\s+configure\s+get|kubectl\s+config\s+view\b[^\r\n]*\s--raw)(?:\s|$)/i
const CREDENTIAL_NAME = /(?:token|secret|password|api[_-]?key|authorization|credential)/i
const LITERAL_SECRET =
  /(?:\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b|\b(?:X-API-Key|API[_ -]?Key)\s*[:=]\s*[A-Za-z0-9._~+/=-]{16,}\b)/i

export function sensitiveText(value: string) {
  return (
    CREDENTIAL_PATH.test(value) ||
    CREDENTIAL_COMMAND.test(value.trim()) ||
    LITERAL_SECRET.test(value) ||
    (/(?:\$\{?|%|\$env:)[A-Za-z_][A-Za-z0-9_]*(?:\}?%?)/i.test(value) && CREDENTIAL_NAME.test(value))
  )
}

export type SanitizedEvidence =
  | { type: "safe"; value: unknown }
  | { type: "sensitive"; reason: string }

const EVIDENCE_CHARS = 32_768
const EVIDENCE_BYTES = 32 * 1024
const EVIDENCE_DEPTH = 32
const EVIDENCE_NODES = 10_000
const OMITTED_TRANSPORT_KEYS = new Set([
  "providermetadata",
  "provideroptions",
  "callprovidermetadata",
])
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "apikey",
  "privatekey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
]
const SENSITIVE_EVIDENCE_TEXT = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /\bBearer\s+\S+/i,
  /\b(?:Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:Authorization|Proxy-Authorization|X-API-Key|Cookie)\s*[:=]\s*\S+/i,
  /(?:^|[\s;])(?:[A-Z0-9_]*(?:TOKEN|API[_-]?KEY|PASSWORD|SECRET|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)[A-Z0-9_]*)\s*=\s*\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /(?:^|[\s"'\\/]|~[\\/])(?:\.env[^\s"'\\/]*|\.npmrc|\.yarnrc[^\s"'\\/]*|\.pypirc|pip(?:\.conf|\.ini)|\.netrc|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|application_default_credentials\.json|[^\s"'\\/]*service[-_]?account[^\s"'\\/]*\.json|\.azure[\\/][^\s"'\\/]+|\.config[\\/]gh[\\/]hosts\.yml|\.ssh[\\/][^\s"'\\/]+|\.aws[\\/](?:credentials|config))(?=$|[\s"'\\/])|[\\/]proc[\\/][^\\/]+[\\/]environ(?:$|[\\/])/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[a-z]?-[A-Za-z0-9-]{8,}\b/i,
]

const canonicalKey = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").toLowerCase()

function sensitiveEvidenceText(value: string) {
  return sensitiveText(value) || SENSITIVE_EVIDENCE_TEXT.some((pattern) => pattern.test(value))
}

function evidenceVisitor(rejectSensitive = true) {
  const seen = new WeakSet<object>()
  let nodes = 0
  let chars = 0
  let bytes = 0

  const fail = (reason: string): SanitizedEvidence => ({ type: "sensitive", reason })
  const count = (value: string) => {
    chars += value.length
    bytes += new TextEncoder().encode(value).byteLength
    return chars <= EVIDENCE_CHARS && bytes <= EVIDENCE_BYTES
  }
  const visit = (input: unknown, depth: number, collect: boolean): SanitizedEvidence => {
    nodes++
    if (nodes > EVIDENCE_NODES || depth > EVIDENCE_DEPTH) return fail("evidence_budget")
    if (input === null || typeof input === "boolean") return { type: "safe", value: input }
    if (typeof input === "number")
      return Number.isFinite(input) ? { type: "safe", value: input } : fail("unsupported_structure")
    if (typeof input === "string") {
      if (!count(input)) return fail("evidence_budget")
      return rejectSensitive && sensitiveEvidenceText(input) ? fail("credential") : { type: "safe", value: input }
    }
    if (typeof input !== "object") return fail("unsupported_structure")
    if (types.isProxy(input)) return fail("unsupported_structure")
    if (seen.has(input)) return fail("unsupported_structure")
    seen.add(input)

    let array: boolean
    try {
      array = Array.isArray(input)
    } catch {
      return fail("unsupported_structure")
    }
    if (array) {
      let proto: object | null
      let keys: PropertyKey[]
      let descriptors: PropertyDescriptorMap
      try {
        proto = Object.getPrototypeOf(input)
        keys = Reflect.ownKeys(input)
        descriptors = Object.getOwnPropertyDescriptors(input)
      } catch {
        return fail("unsupported_structure")
      }
      if (proto !== Array.prototype || keys.some((key) => typeof key === "symbol")) {
        return fail("unsupported_structure")
      }
      const length = descriptors.length
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
        return fail("unsupported_structure")
      }
      if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length.value),
        )
      ) {
        return fail("unsupported_structure")
      }
      const result: unknown[] = []
      for (let index = 0; index < length.value; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("unsupported_structure")
        const next = visit(descriptor.value, depth + 1, collect)
        if (next.type === "sensitive") return next
        if (collect) result.push(next.value)
      }
      return { type: "safe", value: result }
    }

    let proto: object | null
    let keys: PropertyKey[]
    let descriptors: PropertyDescriptorMap
    try {
      proto = Object.getPrototypeOf(input)
      keys = Reflect.ownKeys(input)
      descriptors = Object.getOwnPropertyDescriptors(input)
    } catch {
      return fail("unsupported_structure")
    }
    if (proto !== Object.prototype && proto !== null) return fail("unsupported_structure")
    if (keys.some((key) => typeof key === "symbol")) return fail("unsupported_structure")

    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== "string") return fail("unsupported_structure")
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor)) return fail("unsupported_structure")
      if (!descriptor.enumerable) continue
      const normalized = canonicalKey(key)
      if (OMITTED_TRANSPORT_KEYS.has(normalized)) continue
      if (descriptor.value === undefined) return fail("unsupported_structure")
      if (!count(key)) return fail("evidence_budget")
      if (rejectSensitive && normalized && SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))) {
        return fail("credential_key")
      }
      const next = visit(descriptor.value, depth + 1, collect)
      if (next.type === "sensitive") return next
      if (collect) result[key] = next.value
    }
    return { type: "safe", value: result }
  }

  const container = (
    input: unknown,
    depth: number,
    include: (key: string) => boolean = () => true,
  ): SanitizedEvidence => {
    nodes++
    if (nodes > EVIDENCE_NODES || depth > EVIDENCE_DEPTH) return fail("evidence_budget")
    if (typeof input !== "object" || input === null || seen.has(input)) return fail("unsupported_structure")
    if (types.isProxy(input)) return fail("unsupported_structure")
    seen.add(input)
    let array: boolean
    let proto: object | null
    let keys: PropertyKey[]
    let descriptors: PropertyDescriptorMap
    try {
      array = Array.isArray(input)
      proto = Object.getPrototypeOf(input)
      keys = Reflect.ownKeys(input)
      descriptors = Object.getOwnPropertyDescriptors(input)
    } catch {
      return fail("unsupported_structure")
    }
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      return fail("unsupported_structure")
    }
    if (keys.some((key) => typeof key === "symbol")) return fail("unsupported_structure")
    if (array) {
      const length = descriptors.length
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
        return fail("unsupported_structure")
      }
      if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length.value),
        )
      ) {
        return fail("unsupported_structure")
      }
      for (let index = 0; index < length.value; index++) {
        const key = String(index)
        const descriptor = descriptors[key]
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !count(key)) {
          return descriptor && "value" in descriptor && descriptor.enumerable
            ? fail("evidence_budget")
            : fail("unsupported_structure")
        }
      }
      return { type: "safe", value: input }
    }
    for (const key of keys) {
      if (typeof key !== "string") return fail("unsupported_structure")
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor)) return fail("unsupported_structure")
      if (descriptor.enumerable && include(key) && !count(key)) return fail("evidence_budget")
    }
    return { type: "safe", value: input }
  }

  return {
    inspect(value: unknown, depth = 0) {
      const result = visit(value, depth, false)
      return result.type === "sensitive" ? result : ({ type: "safe" } as const)
    },
    sanitize(value: unknown, depth = 0) {
      return visit(value, depth, true)
    },
    container,
  }
}

export function sanitizeEvidence(value: unknown): SanitizedEvidence {
  const result = evidenceVisitor().sanitize(value)

  if (result.type === "sensitive") return result
  try {
    if (new TextEncoder().encode(JSON.stringify(result.value)).byteLength > EVIDENCE_BYTES) {
      return { type: "sensitive", reason: "evidence_budget" }
    }
  } catch {
    return { type: "sensitive", reason: "unsupported_structure" }
  }
  return result
}

function sanitizeRequest(value: unknown): { request: ReviewRequest; invalid: boolean } | undefined {
  const decode = (input: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(ReviewRequestSchema)(input))
  const sanitized = evidenceVisitor(false).sanitize(value)
  if (sanitized.type === "safe") {
    const request = decode(sanitized.value)
    if (request) return { request, invalid: false }
    return
  }
  if (typeof value !== "object" || value === null) return
  let descriptors: PropertyDescriptorMap
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      return
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return
  }
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return
  const metadata = descriptors.metadata
  if (!metadata || !("value" in metadata)) return
  const fallback = evidenceVisitor(false).sanitize({
    id: descriptors.id?.value,
    sessionID: descriptors.sessionID?.value,
    permission: descriptors.permission?.value,
    patterns: descriptors.patterns?.value,
    metadata: {},
    always: descriptors.always?.value,
    ...(!descriptors.tool || descriptors.tool.value === undefined ? {} : { tool: descriptors.tool.value }),
  })
  if (fallback.type === "sensitive") return
  const request = decode(fallback.value)
  return request ? { request, invalid: true } : undefined
}

function sensitiveRequest(request: ReviewRequest) {
  return (
    request.patterns.some(sensitiveText) ||
    (typeof request.metadata.command === "string" && sensitiveText(request.metadata.command))
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
    const classifications = input.request.patterns.map(classify)
    if (classifications.includes("deny")) return HAZARD
    if (sensitiveText(metadata.command)) return MANUAL
    if (hasCwdTransition(metadata.command)) return MANUAL
    if (scopeLocation(metadata.cwd, input.context.directory) !== "inside") return MANUAL

    const results: Preflight[] = []
    for (const [index, pattern] of input.request.patterns.entries()) {
      if (sensitiveText(pattern)) {
        results.push(MANUAL)
        continue
      }
      const deterministic = classifications[index]
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

export const normalize = (input: PolicyInput): Effect.Effect<string> => {
  const request = sanitizeEvidence(input.request)
  return Effect.succeed(
    sensitiveRequest(input.request) || request.type === "sensitive"
      ? canonical({ type: "sensitive" })
      : canonical({
          request: request.value,
          directory: path.resolve(input.context.directory),
          rulesetDigest: input.context.rulesetDigest,
          targets: input.request.patterns.map((pattern) =>
            targetFact(pattern, input.request.metadata.cwd, input.request.metadata.shell),
          ),
        }),
  )
}

export const rulesetDigest = (ruleset: PermissionV1.Ruleset) =>
  new Bun.CryptoHasher("sha256").update(canonical(ruleset)).digest("hex")

export function decisionAllowed(decision: Decision, risk: Risk) {
  if (risk === "low") return decision === "allow" || decision === "ask"
  if (risk === "medium") return decision === "ask"
  return decision === "ask" || decision === "deny"
}

export type CapturedEvidence =
  | { type: "captured"; serialized: string; digest: string }
  | { type: "manual"; reason: string }

type ManualEvidence = Extract<CapturedEvidence, { type: "manual" }>
type SnapshotTurn = { type: "safe"; messages: SessionV1.WithParts[] } | { type: "manual"; reason: string }

function recordDescriptors(value: unknown) {
  if (typeof value !== "object" || value === null) return
  try {
    if (
      types.isProxy(value) ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
      return
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value)
    return Object.values(descriptors).every((descriptor) => "value" in descriptor) ? descriptors : undefined
  } catch {
    return
  }
}

function arrayValues(value: unknown) {
  if (typeof value !== "object" || value === null) return
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key === "symbol")) return
    const descriptors = Object.getOwnPropertyDescriptors(value as object)
    const length = descriptors.length
    const size = length && "value" in length && typeof length.value === "number" ? length.value : undefined
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) return
    if (
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= size),
      )
    )
      return
    const result: unknown[] = []
    for (let index = 0; index < size; index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return
      result.push(descriptor.value)
    }
    return result
  } catch {
    return
  }
}

function snapshotTurnEvidence(input: {
  messages: ReadonlyArray<SessionV1.WithParts>
  context: ReviewContext
  deniedCallIDs?: ReadonlySet<string>
}): SnapshotTurn {
  const manual = (reason: string): SnapshotTurn => ({ type: "manual", reason })
  const scanner = evidenceVisitor()
  const root = scanner.container(input.messages, 0)
  if (root.type === "sensitive") return manual(root.reason)
  const rawMessages = arrayValues(input.messages)
  if (!rawMessages) return manual("unsupported_structure")
  const headers: Array<{
    raw: object
    info: PropertyDescriptorMap
    rawParts: object
    parts: unknown[]
    id: SessionV1.MessageID
    sessionID: SessionV1.SessionInfo["id"]
    role: "user" | "assistant"
  }> = []
  for (const raw of rawMessages) {
    const message = recordDescriptors(raw)
    if (!message) return manual("unsupported_structure")
    const info = recordDescriptors(message.info?.value)
    const parts = arrayValues(message.parts?.value)
    if (!info || !parts || typeof raw !== "object" || raw === null || typeof message.parts?.value !== "object" || message.parts.value === null) {
      return manual("unsupported_structure")
    }
    const id = Option.getOrUndefined(Schema.decodeUnknownOption(SessionV1.MessageID)(info.id?.value))
    const sessionID = Option.getOrUndefined(Schema.decodeUnknownOption(SessionV1.SessionInfo.fields.id)(info.sessionID?.value))
    const role = info.role?.value
    if (!id || !sessionID || (role !== "user" && role !== "assistant")) return manual("unsupported_structure")
    headers.push({ raw, info, rawParts: message.parts.value, parts, id, sessionID, role })
  }
  const start = headers.findIndex((message) => message.id === input.context.userMessageID && message.role === "user")
  if (start === -1) return manual("current_user")
  const selected = headers.slice(start)
  if (selected.slice(1).some((message) => message.role === "user")) return manual("newer_turn")
  const assistants = selected.filter((message) => message.role === "assistant")
  if (assistants.length !== 1 || assistants[0]?.id !== input.context.assistantMessageID) {
    return manual("current_assistant")
  }
  const assistant = assistants[0]
  if (
    assistant.info.parentID?.value !== input.context.userMessageID ||
    assistant.info.error?.value !== undefined ||
    assistant.info.providerID?.value !== input.context.model.providerID ||
    assistant.info.modelID?.value !== input.context.model.id
  ) {
    return manual("current_assistant")
  }

  const messages: SessionV1.WithParts[] = []
  let currentTools = 0
  for (const message of selected) {
    const messageContainer = scanner.container(message.raw, 1)
    if (messageContainer.type === "sensitive") return manual(messageContainer.reason)
    const infoContainer = scanner.container(message.info, 2)
    if (infoContainer.type === "sensitive") return manual(infoContainer.reason)
    const partsContainer = scanner.container(message.rawParts, 2)
    if (partsContainer.type === "sensitive") return manual(partsContainer.reason)
    const parts: SessionV1.Part[] = []
    for (const raw of message.parts) {
      const part = recordDescriptors(raw)
      if (!part) return manual("unsupported_structure")
      const partContainer = scanner.container(raw, 3, (key) => key !== "url" && key !== "source")
      if (partContainer.type === "sensitive") return manual(partContainer.reason)
      const id = Option.getOrUndefined(Schema.decodeUnknownOption(SessionV1.PartID)(part.id?.value))
      if (
        !id ||
        part.sessionID?.value !== message.sessionID ||
        part.messageID?.value !== message.id ||
        typeof part.type?.value !== "string"
      ) {
        return manual("unsupported_structure")
      }
      const base = { id, sessionID: message.sessionID, messageID: message.id }
      if (message.role === "user" && part.type.value === "file") {
        const mime = part.mime?.value
        const filename = part.filename?.value
        if (typeof mime !== "string" || (filename !== undefined && typeof filename !== "string")) {
          return manual("unsupported_structure")
        }
        const text = `[Attached ${mime}: ${filename ?? "file"}]`
        const inspected = scanner.inspect(text, 4)
        if (inspected.type === "sensitive") return manual(inspected.reason)
        parts.push({ ...base, type: "text", text, synthetic: true })
        continue
      }
      if (message.role === "user" && part.type.value === "text") {
        if (typeof part.text?.value !== "string" || (part.ignored?.value !== undefined && typeof part.ignored.value !== "boolean")) {
          return manual("unsupported_structure")
        }
        const inspected = scanner.inspect(part.text.value, 4)
        if (inspected.type === "sensitive") return manual(inspected.reason)
        parts.push({
          ...base,
          type: "text",
          text: part.text.value,
          ...(part.ignored?.value === undefined ? {} : { ignored: part.ignored.value }),
        })
        continue
      }
      if (message.role === "user" && part.type.value === "compaction") {
        parts.push({ ...base, type: "compaction", auto: false })
        continue
      }
      if (message.role === "user" && part.type.value === "subtask") {
        parts.push({ ...base, type: "subtask", prompt: "", description: "", agent: "" })
        continue
      }
      if (message.role === "assistant" && part.type.value === "tool") {
        const callID = part.callID?.value
        const tool = part.tool?.value
        const state = recordDescriptors(part.state?.value)
        if (typeof callID !== "string" || typeof tool !== "string" || !state || typeof part.state?.value !== "object" || part.state.value === null) {
          return manual("unsupported_structure")
        }
        const stateContainer = scanner.container(part.state.value, 4)
        if (stateContainer.type === "sensitive") return manual(stateContainer.reason)
        const status = state.status?.value
        if (status === "pending" || status === "running") {
          if (callID === input.context.callID) currentTools++
          parts.push({
            ...base,
            type: "tool",
            callID,
            tool,
            state: { status, input: {}, time: { start: 0 } },
          })
          continue
        }
        if (status === "error" && input.deniedCallIDs?.has(callID)) continue
        if (status !== "completed" && status !== "error") return manual("unsupported_structure")
        const toolInput = scanner.sanitize(state.input?.value, 5)
        if (toolInput.type === "sensitive" || !isRecord(toolInput.value)) {
          return manual(toolInput.type === "sensitive" ? toolInput.reason : "unsupported_structure")
        }
        const time = recordDescriptors(state.time?.value)
        if (!time || typeof state.time?.value !== "object" || state.time.value === null) return manual("unsupported_structure")
        const timeContainer = scanner.container(state.time.value, 5)
        if (timeContainer.type === "sensitive") return manual(timeContainer.reason)
        if (status === "completed") {
          if (typeof state.output?.value !== "string") return manual("unsupported_structure")
          const output = time.compacted?.value ? "[Old tool result content cleared]" : truncateEvidenceOutput(state.output.value)
          const inspected = scanner.inspect(output, 5)
          if (inspected.type === "sensitive") return manual(inspected.reason)
          parts.push({
            ...base,
            type: "tool",
            callID,
            tool,
            metadata: {},
            state: {
              status: "completed",
              input: toolInput.value,
              output,
              title: "",
              attachments: [],
              metadata: {},
              time: { start: 0, end: 0, ...(time.compacted?.value === undefined ? {} : { compacted: time.compacted.value }) },
            },
          })
          continue
        }
        if (typeof state.error?.value !== "string") return manual("unsupported_structure")
        const metadataValue = state.metadata?.value
        let metadataRecord: Record<string, unknown> | undefined
        if (metadataValue !== undefined) {
          const metadataDescriptors = recordDescriptors(metadataValue)
          if (!metadataDescriptors) return manual("unsupported_structure")
          const metadataContainer = scanner.container(metadataValue, 5)
          if (metadataContainer.type === "sensitive") return manual(metadataContainer.reason)
          metadataRecord = Object.fromEntries(
            Object.entries(metadataDescriptors).flatMap(([key, descriptor]) =>
              descriptor.enumerable && "value" in descriptor ? [[key, descriptor.value] as const] : [],
            ),
          )
        }
        const metadata = errorEvidenceMetadata(metadataRecord)
        const error = metadata ? "" : truncateEvidenceOutput(state.error.value)
        const inspected = scanner.inspect(metadata ?? error, 5)
        if (inspected.type === "sensitive") return manual(inspected.reason)
        parts.push({
          ...base,
          type: "tool",
          callID,
          tool,
          metadata: {},
          state: { status: "error", input: toolInput.value, error, metadata: metadata ?? {}, time: { start: 0, end: 0 } },
        })
        continue
      }
      if (message.role === "assistant" && (part.type.value === "text" || part.type.value === "reasoning")) {
        if (typeof part.text?.value !== "string") return manual("unsupported_structure")
        const inspected = scanner.inspect(part.text.value, 4)
        if (inspected.type === "sensitive") return manual(inspected.reason)
        parts.push(
          part.type.value === "text"
            ? { ...base, type: "text", text: part.text.value }
            : { ...base, type: "reasoning", text: part.text.value, time: { start: 0 } },
        )
        continue
      }
      if (message.role === "assistant" && part.type.value === "step-start") {
        parts.push({ ...base, type: "step-start" })
      }
    }
    messages.push({
      info:
        message.role === "user"
          ? {
              id: message.id,
              sessionID: message.sessionID,
              role: "user",
              time: { created: 0 },
              agent: input.context.agentID,
              model: { providerID: input.context.model.providerID, modelID: input.context.model.id },
            }
          : {
              id: message.id,
              sessionID: message.sessionID,
              role: "assistant",
              time: { created: 0 },
              parentID: input.context.userMessageID,
              providerID: input.context.model.providerID,
              modelID: input.context.model.id,
              mode: "plan",
              agent: input.context.agentID,
              path: { cwd: "", root: "" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      parts,
    })
  }
  return currentTools === 1 ? { type: "safe", messages } : manual("current_tool")
}

export const captureEvidence = Effect.fn("PlanReview.captureEvidence")(function* (input: {
  messages: ReadonlyArray<SessionV1.WithParts>
  context: ReviewContext
  deniedCallIDs?: ReadonlySet<string>
}) {
  const snapshot = snapshotTurnEvidence(input)
  if (snapshot.type === "manual") return snapshot satisfies CapturedEvidence
  const turn = snapshot.messages

  const projected: SessionV1.WithParts[] = []
  for (const message of turn) {
    if (!hasOnlyDataProperties(message) || !hasOnlyDataProperties(message.info)) {
      return { type: "manual", reason: "unsupported_structure" } satisfies CapturedEvidence
    }
    const parts: SessionV1.Part[] = []
    for (const part of message.parts) {
      if (!hasOnlyDataProperties(part)) {
        return { type: "manual", reason: "unsupported_structure" } satisfies CapturedEvidence
      }
      if (message.info.role === "user" && part.type === "file") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
          synthetic: true,
        })
        continue
      }
      if (message.info.role === "user" && part.type === "text") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: part.text,
          ...(part.ignored === undefined ? {} : { ignored: part.ignored }),
        })
        continue
      }
      if (message.info.role === "user" && part.type === "compaction") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "compaction",
          auto: false,
        })
        continue
      }
      if (message.info.role === "user" && part.type === "subtask") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "subtask",
          prompt: "",
          description: "",
          agent: "",
        })
        continue
      }
      if (message.info.role === "assistant" && part.type === "tool") {
        if (!hasOnlyDataProperties(part.state)) {
          return { type: "manual", reason: "unsupported_structure" } satisfies CapturedEvidence
        }
        if (part.state.status === "pending" || part.state.status === "running") continue
        if (part.state.status === "error" && input.deniedCallIDs?.has(part.callID)) continue
        if (part.state.status === "completed") {
          parts.push({
            id: part.id,
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "tool",
            callID: part.callID,
            tool: part.tool,
            metadata: {},
            state: {
              status: "completed",
              input: part.state.input,
              output: part.state.time.compacted
                ? "[Old tool result content cleared]"
                : truncateEvidenceOutput(part.state.output),
              title: "",
              attachments: [],
              metadata: {},
              time: {
                start: 0,
                end: 0,
                ...(part.state.time.compacted === undefined ? {} : { compacted: part.state.time.compacted }),
              },
            },
          })
          continue
        }
        const metadata = errorEvidenceMetadata(part.state.metadata)
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "tool",
          callID: part.callID,
          tool: part.tool,
          metadata: {},
          state: {
            status: "error",
            input: part.state.input,
            error: metadata ? "" : truncateEvidenceOutput(part.state.error),
            metadata: metadata ?? {},
            time: { start: 0, end: 0 },
          },
        })
        continue
      }
      if (message.info.role === "assistant" && part.type === "text") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: part.text,
        })
        continue
      }
      if (message.info.role === "assistant" && part.type === "reasoning") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "reasoning",
          text: part.text,
          time: { start: 0 },
        })
        continue
      }
      if (message.info.role === "assistant" && part.type === "step-start") {
        parts.push({
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "step-start",
        })
        continue
      }
    }
    projected.push({
      info:
        message.info.role === "user"
          ? {
              id: message.info.id,
              sessionID: message.info.sessionID,
              role: "user",
              time: { created: 0 },
              agent: input.context.agentID,
              model: {
                providerID: input.context.model.providerID,
                modelID: input.context.model.id,
              },
            }
          : {
              id: message.info.id,
              sessionID: message.info.sessionID,
              role: "assistant",
              time: { created: 0 },
              parentID: input.context.userMessageID,
              providerID: input.context.model.providerID,
              modelID: input.context.model.id,
              mode: "plan",
              agent: input.context.agentID,
              path: { cwd: "", root: "" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      parts,
    })
  }
  const messages = yield* MessageV2.toModelMessagesEffect(projected, input.context.model, {
    stripMedia: true,
    toolOutputMaxChars: 4_000,
  }).pipe(Effect.option)
  if (Option.isNone(messages)) return { type: "manual", reason: "conversion" } satisfies CapturedEvidence
  const evidenceMessages = projectModelEvidence(messages.value)
  if (evidenceMessages.type === "manual") return evidenceMessages satisfies CapturedEvidence
  const sanitized = sanitizeEvidence(evidenceMessages.value)
  if (sanitized.type === "sensitive") {
    return { type: "manual", reason: sanitized.reason } satisfies CapturedEvidence
  }
  let serialized: string
  try {
    serialized = canonical(sanitized.value)
  } catch {
    return { type: "manual", reason: "serialization" } satisfies CapturedEvidence
  }
  if (new TextEncoder().encode(serialized).byteLength > EVIDENCE_BYTES) {
    return { type: "manual", reason: "evidence_budget" } satisfies CapturedEvidence
  }
  return {
    type: "captured",
    serialized,
    digest: Hash.sha256(serialized),
  } satisfies CapturedEvidence
})

function projectModelEvidence(messages: readonly ModelMessage[]): { type: "safe"; value: unknown } | ManualEvidence {
  const result: unknown[] = []
  for (const message of messages) {
    if (message.role === "system") return { type: "manual", reason: "unsupported_structure" }
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content })
      continue
    }

    const content: unknown[] = []
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text })
        continue
      }
      if (message.role === "assistant" && part.type === "reasoning") {
        content.push({ type: "reasoning", text: part.text })
        continue
      }
      if (message.role === "assistant" && part.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        })
        continue
      }
      if (message.role === "tool" && part.type === "tool-result") {
        const output = projectModelToolOutput(part.output)
        if (!output) return { type: "manual", reason: "unsupported_structure" }
        content.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
        })
        continue
      }
      return { type: "manual", reason: "unsupported_structure" }
    }
    result.push({ role: message.role, content })
  }
  return { type: "safe", value: result }
}

function projectModelToolOutput(output: unknown) {
  if (!isRecord(output) || typeof output.type !== "string") return
  if (output.type === "text" || output.type === "error-text" || output.type === "json" || output.type === "error-json") {
    return { type: output.type, value: output.value }
  }
  if (output.type === "execution-denied") {
    return {
      type: output.type,
      ...(output.reason === undefined ? {} : { reason: output.reason }),
    }
  }
}

function hasOnlyDataProperties(value: object) {
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
  } catch {
    return false
  }
}

function truncateEvidenceOutput(value: string) {
  if (value.length <= 4_000) return value
  const suffix = "\n[Tool output truncated]"
  return `${value.slice(0, 4_000 - suffix.length)}${suffix}`
}

function errorEvidenceMetadata(value: Readonly<Record<string, unknown>> | undefined) {
  if (!value || !hasOnlyDataProperties(value)) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (descriptors.interrupted?.value !== true || typeof descriptors.output?.value !== "string") return undefined
  return { interrupted: true, output: truncateEvidenceOutput(descriptors.output.value) }
}

type LiveAuthority = {
  context: ReviewContext
  findings: readonly Finding[]
  normalized: string
  request: ReviewRequest
  ruleset: PermissionV1.Ruleset
}

type Authority = { type: "live"; value: LiveAuthority } | { type: "outcome"; value: Outcome }

type ReviewBaseline = {
  evidenceDigest: string
  permissionDigest: string
  envelopeDigest: string
  normalized: string
}

type ProviderAttempt =
  | { type: "success"; output: Output; usage: unknown; metadata: unknown; body: unknown }
  | { type: "invalid"; error: NoObjectGeneratedError }
  | { type: "failure"; error: unknown }
  | { type: "interrupted" }

type ReplaySignal = { type: "deny"; outcome: Extract<Outcome, { type: "deny" }> } | { type: "retry" }
type ReplayEntry =
  | { type: "pending"; deferred: Deferred.Deferred<ReplaySignal> }
  | { type: "denied"; outcome: Extract<Outcome, { type: "deny" }> }

type AssistantReviewState = {
  entries: Map<string, ReplayEntry>
  deniedCallIDs: Set<string>
  saturated: boolean
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 }

function maximumRisk(model: Risk, findings: readonly Finding[]): Risk {
  return findings.reduce<Risk>((result, finding) => (RISK_ORDER[finding.risk] > RISK_ORDER[result] ? finding.risk : result), model)
}

function evaluateRules(request: ReviewRequest, ruleset: PermissionV1.Ruleset) {
  return request.patterns.map(
    (pattern) =>
      ruleset.findLast(
        (rule) => Wildcard.match(request.permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
      ) ?? { permission: request.permission, pattern: "*", action: "ask" as const },
  )
}

function permissionMaterial(input: ReviewInput, authority: LiveAuthority, evidenceDigest: string) {
  const request = sanitizeEvidence({
    id: authority.request.id,
    sessionID: authority.request.sessionID,
    permission: authority.request.permission,
    patterns: authority.request.patterns,
    metadata: authority.request.metadata,
    always: authority.request.always,
    tool: authority.request.tool,
  })
  if (request.type === "sensitive") return request
  const semantic = sanitizeEvidence({
    permission: authority.request.permission,
    patterns: authority.request.patterns,
    metadata: authority.request.metadata,
    always: authority.request.always,
    findings: authority.findings,
    targets: authority.request.patterns.map((pattern) =>
      targetFact(pattern, authority.request.metadata.cwd, authority.request.metadata.shell),
    ),
  })
  if (semantic.type === "sensitive") return semantic
  const permissionDigest = Hash.sha256(
    canonical({ request: request.value, findings: authority.findings, normalized: authority.normalized }),
  )
  const envelopeDigest = Hash.sha256(
    canonical({
      requestID: authority.request.id,
      sessionID: authority.request.sessionID,
      userMessageID: input.context.userMessageID,
      assistantMessageID: input.context.assistantMessageID,
      callID: input.context.callID,
      agentID: input.context.agentID,
      permissionDigest,
      evidenceDigest,
    }),
  )
  return {
    type: "safe" as const,
    request: request.value,
    permissionDigest,
    semanticDigest: Hash.sha256(canonical(semantic.value)),
    envelopeDigest,
  }
}

function unavailableModel(model: Provider.Model) {
  const provider = model.providerID.toLowerCase()
  const api = model.api.id.toLowerCase()
  const id = model.id.toLowerCase()
  const npm = model.api.npm.toLowerCase()
  const upstream = api.split("/", 1)[0] ?? ""
  const identifiers = [provider, api, id]
  if (npm === "@openrouter/ai-sdk-provider" || identifiers.includes("openrouter") || upstream === "openrouter") return true
  if (npm === "@ai-sdk/perplexity" || identifiers.includes("perplexity") || upstream === "perplexity") return true
  if (
    /(?:^|\/)(?:gpt-4o|gpt-4o-mini)-search-preview(?:-|$)/.test(api) ||
    /(?:^|\/)(?:gpt-4o|gpt-4o-mini)-search-preview(?:-|$)/.test(id)
  )
    return true
  const groq = npm === "@ai-sdk/groq" || provider === "groq" || upstream === "groq"
  if (groq && [api, id].some((value) => /(?:^|\/)compound(?:-mini)?$/.test(value))) return true
  const qwen = npm === "@ai-sdk/alibaba" || provider === "alibaba" || provider === "qwen" || ["alibaba", "qwen"].includes(upstream)
  if (qwen && [api, id].some((value) => /(?:^|\/)qwen-deep-research(?:-|$)/.test(value))) return true
  if ([provider, api, id].some((value) => /(?:^|[/-])deep-research(?:[/-]|$)/.test(value))) return true
  try {
    const hostname = new URL(model.api.url).hostname.toLowerCase().replace(/\.+$/, "")
    return ["openrouter.ai", "perplexity.ai"].some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))
  } catch {
    return true
  }
}

function hasGoogleAgent(language: unknown) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(language, "agent")
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length > 0
  } catch {
    return true
  }
}

function reviewerOptions(input: {
  model: Provider.Model
  auth: Auth.Info | undefined
  privacy: LLMRequestPrep.Prepared["privacy"]
}) {
  const npm = input.model.api.npm
  const api = input.model.api.id.toLowerCase()
  const provider = input.model.providerID.toLowerCase()
  const oauth = provider === "openai" && input.auth?.type === "oauth"
  const instructions = oauth || (npm === "@ai-sdk/github-copilot" && /^(?:o1-mini|o1-preview)/.test(api))
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure") {
    return {
      store: false,
      promptCacheOptions: { mode: "explicit" },
      promptCacheRetention: "in_memory",
      ...(instructions ? { instructions: REVIEW_POLICY } : {}),
    }
  }
  if (npm === "@ai-sdk/github-copilot") {
    return { store: false, ...(instructions ? { instructions: REVIEW_POLICY } : {}) }
  }
  if (["@ai-sdk/amazon-bedrock/mantle", "@ai-sdk/xai", "@ai-sdk/google"].includes(npm)) {
    return { store: false }
  }
  if (npm === "@ai-sdk/anthropic") {
    return input.privacy.inferenceGeo ? { inferenceGeo: input.privacy.inferenceGeo } : {}
  }
  if (npm === "@ai-sdk/gateway") {
    const upstream = api.split("/", 1)[0] ?? ""
    const openai = upstream === "openai" || upstream === "azure"
    return {
      gateway: { zeroDataRetention: true, disallowPromptTraining: true, hipaaCompliant: true },
      ...(["openai", "azure", "xai"].includes(upstream) ? { store: false } : {}),
      ...(openai
        ? { promptCacheOptions: { mode: "explicit" }, promptCacheRetention: "in_memory" }
        : {}),
    }
  }
  return {}
}

function responseBody(response: unknown) {
  return isRecord(response) ? response["body"] : undefined
}

export function reviewOutcome(output: Output, findings: readonly Finding[]): Outcome {
  const effectiveRisk = maximumRisk(output.risk, findings)
  const text = sanitizeEvidence({
    reason: output.reason,
    ...(output.alternative === undefined ? {} : { alternative: output.alternative }),
  })
  if (
    text.type === "sensitive" ||
    !decisionAllowed(output.decision, effectiveRisk) ||
    (output.decision !== "deny" && output.alternative !== undefined)
  ) {
    return { type: "ask", review: { ...FALLBACK_REVIEW, risk: effectiveRisk } }
  }
  if (output.decision === "allow") return { type: "allow" }
  if (output.decision === "ask") return { type: "ask", review: { risk: effectiveRisk, reason: output.reason } }
  return { type: "deny", reason: output.reason, alternative: output.alternative }
}

function waitForAbort(signal: AbortSignal) {
  return Effect.callback<"abort">((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed("abort"))
      return
    }
    const listener = () => resume(Effect.succeed("abort"))
    signal.addEventListener("abort", listener, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", listener))
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const providers = yield* Provider.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const { db } = yield* Database.Service
    const states = new Map<string, AssistantReviewState>()
    const sources = new WeakMap<ReviewInput, unknown>()

    const stateFor = (input: ReviewInput) => {
      const key = `${input.request.sessionID}\u0000${input.context.assistantMessageID}`
      const current = states.get(key)
      if (current) return current
      const created: AssistantReviewState = { entries: new Map(), deniedCallIDs: new Set(), saturated: false }
      states.set(key, created)
      return created
    }

    const authority = Effect.fn("PlanReview.authority")(function* (input: {
      review: ReviewInput
      normalized?: string
    }): Effect.fn.Return<Authority> {
      if (input.review.context.abort.aborted || !(yield* input.review.isActive())) {
        return { type: "outcome", value: { type: "cancel" } }
      }
      const fresh = yield* sessions.get(input.review.request.sessionID).pipe(Effect.option)
      if (Option.isNone(fresh)) return { type: "outcome", value: { type: "cancel" } }
      const observed = sanitizeRequest(sources.get(input.review) ?? input.review.request)
      const request = observed && !observed.invalid ? observed.request : input.review.request
      const ruleset = [...input.review.context.agent.permission, ...(fresh.value.permission ?? [])]
      if (evaluateRules(request, ruleset).some((rule) => rule.action === "deny")) {
        return { type: "outcome", value: { type: "configured_deny" } }
      }
      const current: ReviewContext = {
        ...input.review.context,
        approvalMode: fresh.value.approvalMode,
        rulesetDigest: rulesetDigest(ruleset),
      }
      const policy = { request, context: current }
      const checked = yield* preflight(policy)
      if (checked.type === "deny") {
        return {
          type: "outcome",
          value: { type: "read_only", reason: checked.reason, alternative: checked.alternative },
        }
      }
      if (checked.type === "ask") return { type: "outcome", value: { type: "manual" } }
      if (!observed || observed.invalid) return { type: "outcome", value: { type: "manual" } }
      if (fresh.value.approvalMode !== "auto_review") return { type: "outcome", value: { type: "manual" } }
      if (
        request.sessionID !== input.review.context.messages[0]?.info.sessionID ||
        request.tool?.messageID !== input.review.context.assistantMessageID ||
        request.tool.callID !== input.review.context.callID
      ) {
        return { type: "outcome", value: { type: "cancel" } }
      }
      if (
        fresh.value.directory !== input.review.context.directory ||
        (fresh.value.agent !== undefined && fresh.value.agent !== input.review.context.agentID) ||
        (fresh.value.model !== undefined &&
          (fresh.value.model.providerID !== input.review.context.model.providerID ||
            fresh.value.model.id !== input.review.context.model.id)) ||
        current.rulesetDigest !== input.review.context.rulesetDigest ||
        canonical(checked.findings) !== canonical(input.review.findings)
      ) {
        return { type: "outcome", value: { type: "manual" } }
      }
      const normalized = yield* normalize(policy)
      if (input.normalized !== undefined && normalized !== input.normalized) {
        return { type: "outcome", value: { type: "manual" } }
      }
      return { type: "live", value: { context: current, findings: checked.findings, normalized, request, ruleset } }
    })

    const finalize = Effect.fn("PlanReview.finalize")(function* (input: {
      review: ReviewInput
      candidate: Outcome
      baseline?: ReviewBaseline
      state: AssistantReviewState
    }): Effect.fn.Return<Outcome> {
      const checked = yield* authority({ review: input.review, normalized: input.baseline?.normalized })
      if (checked.type === "outcome") return checked.value
      const messages = yield* sessions.messages({ sessionID: input.review.request.sessionID, limit: 64 }).pipe(Effect.option)
      if (Option.isNone(messages)) return { type: "cancel" }
      const evidence = yield* captureEvidence({
        messages: messages.value,
        context: checked.value.context,
        deniedCallIDs: input.state.deniedCallIDs,
      })
      if (evidence.type === "manual") {
        if (input.review.context.abort.aborted || !(yield* input.review.isActive())) return { type: "cancel" }
        return { type: "manual" }
      }
      if (input.baseline) {
        const material = permissionMaterial(input.review, checked.value, evidence.digest)
        if (material.type === "sensitive") return { type: "manual" }
        if (
          evidence.digest !== input.baseline.evidenceDigest ||
          material.permissionDigest !== input.baseline.permissionDigest ||
          material.envelopeDigest !== input.baseline.envelopeDigest
        ) {
          return { type: "manual" }
        }
      }
      const finalAuthority = yield* authority({ review: input.review, normalized: input.baseline?.normalized })
      if (finalAuthority.type === "outcome") return finalAuthority.value
      const finalMessages = yield* sessions.messages({ sessionID: input.review.request.sessionID, limit: 64 }).pipe(Effect.option)
      if (Option.isNone(finalMessages)) return { type: "cancel" }
      const finalEvidence = yield* captureEvidence({
        messages: finalMessages.value,
        context: finalAuthority.value.context,
        deniedCallIDs: input.state.deniedCallIDs,
      })
      if (finalEvidence.type === "manual") {
        if (input.review.context.abort.aborted || !(yield* input.review.isActive())) return { type: "cancel" }
        return { type: "manual" }
      }
      if (input.baseline) {
        const material = permissionMaterial(input.review, finalAuthority.value, finalEvidence.digest)
        if (material.type === "sensitive") return { type: "manual" }
        if (
          finalEvidence.digest !== input.baseline.evidenceDigest ||
          material.permissionDigest !== input.baseline.permissionDigest ||
          material.envelopeDigest !== input.baseline.envelopeDigest
        ) {
          return { type: "manual" }
        }
      }
      const committedAuthority = yield* authority({ review: input.review, normalized: input.baseline?.normalized })
      if (committedAuthority.type === "outcome") return committedAuthority.value
      return input.candidate
    })

    const account = Effect.fn("PlanReview.account")(function* (input: {
      attempt: ProviderAttempt
      model: Provider.Model
      sessionID: SessionV1.SessionInfo["id"]
    }) {
      const usage =
        input.attempt.type === "success"
          ? LLMAISDK.usage(input.attempt.usage)
          : input.attempt.type === "invalid"
            ? LLMAISDK.usage(input.attempt.error.usage)
            : undefined
      if (!usage) return
      const metadata =
        input.attempt.type === "success" ? LLMAISDK.providerMetadata(input.attempt.metadata) : undefined
      const body =
        input.attempt.type === "success"
          ? input.attempt.body
          : input.attempt.type === "invalid"
            ? responseBody(input.attempt.error.response)
            : undefined
      const totalNanoAiu = LLMAISDK.copilotTotalNanoAiu(body)
      const withBilling =
        totalNanoAiu === undefined
          ? metadata
          : {
              ...metadata,
              copilot: { ...metadata?.copilot, totalNanoAiu },
            }
      yield* SessionProjector.addUsage(
        db,
        input.sessionID,
        Session.getUsage({ model: input.model, usage, metadata: withBilling }),
      )
    })

    const callProvider = (input: {
      params: Parameters<typeof generateObject>[0]
      oauth: boolean
      model: Provider.Model
      sessionID: SessionV1.SessionInfo["id"]
    }) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* restore(
            Effect.tryPromise({
              try: async () => {
                if (input.oauth) {
                  const streamed = streamObject(input.params)
                  for await (const part of streamed.fullStream) {
                    if (part.type === "error") throw part.error
                  }
                  const response = await streamed.response
                  return {
                    object: await streamed.object,
                    usage: await streamed.usage,
                    providerMetadata: await streamed.providerMetadata,
                    body: responseBody(response),
                  }
                }
                const generated = await generateObject(input.params)
                return {
                  object: generated.object,
                  usage: generated.usage,
                  providerMetadata: generated.providerMetadata,
                  body: responseBody(generated.response),
                }
              },
              catch: (cause) => cause,
            }),
          ).pipe(Effect.exit)
          const attempt: ProviderAttempt = Exit.isSuccess(result)
            ? {
                type: "success",
                output: result.value.object as Output,
                usage: result.value.usage,
                metadata: result.value.providerMetadata,
                body: result.value.body,
              }
            : Option.match(Cause.findErrorOption(result.cause), {
                onNone: () => ({ type: "interrupted" as const }),
                onSome: (error) =>
                  NoObjectGeneratedError.isInstance(error)
                    ? ({ type: "invalid" as const, error })
                    : ({ type: "failure" as const, error }),
              })
          yield* account({ attempt, model: input.model, sessionID: input.sessionID }).pipe(Effect.uninterruptible)
          return attempt
        }),
      )

    const infer = Effect.fn("PlanReview.infer")(function* (input: {
      review: ReviewInput
      authority: LiveAuthority
      evidence: Extract<CapturedEvidence, { type: "captured" }>
      request: unknown
      baseline: ReviewBaseline
      state: AssistantReviewState
    }): Effect.fn.Return<Outcome> {
      const gate = yield* finalize({
        review: input.review,
        candidate: { type: "allow" },
        baseline: input.baseline,
        state: input.state,
      })
      if (gate.type !== "allow") return gate
      if (unavailableModel(input.review.context.model)) {
        return yield* finalize({ review: input.review, candidate: { type: "manual" }, baseline: input.baseline, state: input.state })
      }
      const language = yield* providers.getLanguage(input.review.context.model).pipe(Effect.exit)
      if (Exit.isFailure(language)) {
        return yield* finalize({
          review: input.review,
          candidate: Cause.hasInterruptsOnly(language.cause)
            ? { type: "cancel" }
            : { type: "ask", review: FALLBACK_REVIEW },
          baseline: input.baseline,
          state: input.state,
        })
      }
      if (language.value instanceof GitLabWorkflowLanguageModel || hasGoogleAgent(language.value)) {
        return yield* finalize({ review: input.review, candidate: { type: "manual" }, baseline: input.baseline, state: input.state })
      }
      const user = input.review.context.messages.find(
        (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
          message.info.id === input.review.context.userMessageID && message.info.role === "user",
      )
      if (!user) {
        return yield* finalize({ review: input.review, candidate: { type: "manual" }, baseline: input.baseline, state: input.state })
      }
      const info = yield* providers.getProvider(input.review.context.model.providerID)
      const authResult = yield* auth.get(input.review.context.model.providerID).pipe(Effect.result)
      if (Result.isFailure(authResult)) {
        return yield* finalize({
          review: input.review,
          candidate: { type: "ask", review: FALLBACK_REVIEW },
          baseline: input.baseline,
          state: input.state,
        })
      }
      const data: ModelMessage = {
        role: "user",
        content: `<UNTRUSTED_REVIEW_DATA>\n{"evidence":${input.evidence.serialized},"findings":${canonical(input.authority.findings)},"request":${canonical(input.request)}}\n</UNTRUSTED_REVIEW_DATA>`,
      }
      const prepared = yield* LLMRequestPrep.prepare({
        user: { ...user.info, system: undefined, tools: undefined },
        sessionID: input.review.request.sessionID,
        model: input.review.context.model,
        agent: { ...input.review.context.agent, prompt: REVIEW_POLICY, permission: [] },
        permission: [],
        system: [],
        messages: [data],
        tools: {},
        provider: info,
        auth: authResult.success,
        plugin,
        flags,
        isWorkflow: false,
        skipSystemTransform: true,
      })
      if (prepared.system.length !== 1 || prepared.system[0] !== REVIEW_POLICY) {
        return yield* finalize({ review: input.review, candidate: { type: "manual" }, baseline: input.baseline, state: input.state })
      }
      if (input.review.context.model.api.npm === "@ai-sdk/anthropic" && prepared.privacy.invalidInferenceGeo) {
        return yield* finalize({ review: input.review, candidate: { type: "manual" }, baseline: input.baseline, state: input.state })
      }
      const cfg = yield* config.get()
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, property, receiver) {
              if (property !== "startSpan") return Reflect.get(target, property, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.review.request.sessionID)
                return span
              }
            },
          })
        : undefined
      const options = reviewerOptions({
        model: input.review.context.model,
        auth: authResult.success,
        privacy: prepared.privacy,
      })
      const params = {
        model: language.value,
        schema: Object.assign(Schema.toStandardSchemaV1(Output), Schema.toStandardJSONSchemaV1(Output)),
        messages: prepared.messages,
        temperature: prepared.params.temperature,
        topP: prepared.params.topP,
        topK: prepared.params.topK,
        maxOutputTokens: prepared.params.maxOutputTokens,
        providerOptions: ProviderTransform.providerOptions(input.review.context.model, options),
        headers: prepared.headers,
        abortSignal: input.review.context.abort,
        maxRetries: 0,
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.plan-review",
          tracer: telemetryTracer,
          metadata: { userId: cfg.username ?? "unknown", sessionId: input.review.request.sessionID },
          recordInputs: false,
          recordOutputs: false,
        },
      } satisfies Parameters<typeof generateObject>[0]
      const ready = yield* finalize({
        review: input.review,
        candidate: { type: "allow" },
        baseline: input.baseline,
        state: input.state,
      })
      if (ready.type !== "allow") return ready
      const attempt = yield* callProvider({
        params,
        oauth: input.review.context.model.providerID === "openai" && authResult.success?.type === "oauth",
        model: input.review.context.model,
        sessionID: input.review.request.sessionID,
      })
      const candidate =
        attempt.type === "success"
          ? reviewOutcome(attempt.output, input.authority.findings)
          : attempt.type === "interrupted"
            ? ({ type: "cancel" } as const)
            : ({ type: "ask", review: FALLBACK_REVIEW } as const)
      return yield* finalize({ review: input.review, candidate, baseline: input.baseline, state: input.state })
    })

    const review = Effect.fn("PlanReview.review")(function* (raw: ReviewInput): Effect.fn.Return<Outcome> {
      const started = Date.now()
      const sanitized = sanitizeRequest(raw.request)
      if (!sanitized) {
        yield* Effect.logInfo("plan permission reviewed", {
          requestID: "invalid",
          sessionID: "invalid",
          permission: "invalid",
          outcome: "manual",
          risk: undefined,
          elapsed: Date.now() - started,
          reasonCode: "stale_authority",
        })
        return { type: "manual" }
      }
      const input: ReviewInput = {
        request: sanitized.request,
        context: raw.context,
        findings: raw.findings,
        isActive: raw.isActive,
      }
      sources.set(input, raw.request)
      const state = stateFor(input)
      const initial = yield* authority({ review: input })
      const run = initial.type === "outcome"
        ? finalize({ review: input, candidate: initial.value, state })
        : sanitized.invalid
          ? finalize({ review: input, candidate: { type: "manual" }, state })
        : Effect.gen(function* () {
            if (state.saturated) return yield* finalize({ review: input, candidate: { type: "manual" }, state })
            const evidence = yield* captureEvidence({
              messages: input.context.messages,
              context: initial.value.context,
              deniedCallIDs: state.deniedCallIDs,
            })
            if (evidence.type === "manual") {
              return yield* finalize({ review: input, candidate: { type: "manual" }, state })
            }
            const stateKey = `${input.request.sessionID}\u0000${input.context.assistantMessageID}`
            for (const existing of states.keys()) {
              if (existing.startsWith(`${input.request.sessionID}\u0000`) && existing !== stateKey) states.delete(existing)
            }
            const material = permissionMaterial(input, initial.value, evidence.digest)
            if (material.type === "sensitive") {
              return yield* finalize({ review: input, candidate: { type: "manual" }, state })
            }
            const baseline: ReviewBaseline = {
              evidenceDigest: evidence.digest,
              permissionDigest: material.permissionDigest,
              envelopeDigest: material.envelopeDigest,
              normalized: initial.value.normalized,
            }
            const key = `${material.semanticDigest}\u0000${evidence.digest}`

            const loop: Effect.Effect<Outcome> = Effect.suspend(() =>
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                if (state.saturated) return yield* finalize({ review: input, candidate: { type: "manual" }, state })
                const claim = yield* Effect.sync(() => {
                  const current = state.entries.get(key)
                  if (current) return current
                  if (
                    state.deniedCallIDs.size >= 64 ||
                    [...state.entries.values()].filter((entry) => entry.type === "denied").length >= 64
                  ) {
                    state.saturated = true
                    return { type: "saturated" as const }
                  }
                  if (state.entries.size >= 64) return { type: "capacity" as const }
                  const pending: ReplayEntry = { type: "pending", deferred: Deferred.makeUnsafe<ReplaySignal>() }
                  state.entries.set(key, pending)
                  return { type: "leader" as const, pending }
                })
                if (claim.type === "saturated" || claim.type === "capacity") {
                  return yield* finalize({ review: input, candidate: { type: "manual" }, state })
                }
                if (claim.type === "denied") {
                  if (state.deniedCallIDs.size >= 64) state.saturated = true
                  const reused = yield* finalize({ review: input, candidate: claim.outcome, baseline, state })
                  if (reused.type === "deny" && state.deniedCallIDs.size < 64) state.deniedCallIDs.add(input.context.callID)
                  return reused
                }
                if (claim.type === "pending") {
                  const signal = yield* restore(
                    Effect.race(Deferred.await(claim.deferred), waitForAbort(input.context.abort)),
                  )
                  if (signal === "abort") return { type: "cancel" }
                  if (signal.type === "retry") return yield* loop
                  const reused = yield* finalize({ review: input, candidate: signal.outcome, baseline, state })
                  if (reused.type === "deny") {
                    if (state.deniedCallIDs.size < 64) state.deniedCallIDs.add(input.context.callID)
                    else state.saturated = true
                  }
                  return reused
                }

                const exit = yield* restore(
                  infer({
                    review: input,
                    authority: initial.value,
                    evidence,
                    request: material.request,
                    baseline,
                    state,
                  }),
                ).pipe(Effect.exit)
                if (Exit.isSuccess(exit) && exit.value.type === "deny") {
                  const denial = exit.value
                  yield* Effect.uninterruptible(
                    Effect.sync(() => {
                      state.entries.set(key, { type: "denied", outcome: denial })
                      if (state.deniedCallIDs.size < 64) state.deniedCallIDs.add(input.context.callID)
                      else state.saturated = true
                    }).pipe(
                      Effect.andThen(Deferred.succeed(claim.pending.deferred, { type: "deny", outcome: denial })),
                    ),
                  )
                  return denial
                }
                yield* Deferred.succeed(claim.pending.deferred, { type: "retry" }).pipe(
                  Effect.andThen(Effect.sync(() => state.entries.delete(key))),
                )
                if (Exit.isSuccess(exit)) return exit.value
                if (Cause.hasInterruptsOnly(exit.cause)) return { type: "cancel" }
                return yield* finalize({
                  review: input,
                  candidate: { type: "ask", review: FALLBACK_REVIEW },
                  baseline,
                  state,
                })
                }),
              ),
            )
            return yield* loop
          })
      const result = yield* run
      yield* Effect.logInfo("plan permission reviewed", {
        requestID: input.request.id,
        sessionID: input.request.sessionID,
        permission: input.request.permission,
        outcome: result.type,
        risk: result.type === "ask" ? result.review.risk : undefined,
        elapsed: Date.now() - started,
        reasonCode: reasonCode(result),
      })
      return result
    })

    return Service.of({ review })
  }),
)

function reasonCode(outcome: Outcome) {
  if (outcome.type === "allow") return "model_allow"
  if (outcome.type === "ask") return "manual_review"
  if (outcome.type === "deny") return "model_deny"
  if (outcome.type === "configured_deny") return "configured_deny"
  if (outcome.type === "read_only") return "plan_read_only"
  if (outcome.type === "cancel") return "cancelled"
  return "stale_authority"
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Provider.node, Auth.node, Plugin.node, Config.node, RuntimeFlags.node, Database.node],
})

export * as PlanReview from "./plan-review"

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
  if (/(?:^|[\s"'])~/.test(text)) return "ask"
  if (/\s(?:>|>>)(?:\s|$)|(?:>|>>)\s*\S/.test(text)) return "deny"
  if (/(?:^|\s)(?:tee|Tee-Object|Out-File)(?:\s|$)/i.test(text)) return "deny"
  if (
    /^(?:rm\s+-[^\r\n]*r|Remove-Item\b[^\r\n]*-Recurse|del\s+\/s|format(?:\s|$)|git\s+(?:reset\s+--hard|clean\b))/i.test(
      text,
    )
  )
    return "deny"
  if (
    /^(?:rm|unlink|del|erase|touch|mkdir|md|rd|rmdir|Set-Content|Add-Content|New-Item|Rename-Item|Move-Item|Copy-Item|Remove-Item|cp|mv|move|copy|ren|rename)(?:\s|$)/i.test(
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
  if (/^find\b[^\r\n]*\s-(?:fprint|fprint0|fprintf|fls)(?:\s|$)/i.test(text)) return "deny"
  if (/^find\b[^\r\n]*\s-(?:exec|execdir|ok|okdir)(?:\s|$)/i.test(text)) return "ask"
  if (/(?:^|\s)(?:--fix|--write|--update-snapshots|-u)(?:\s|$)/i.test(text)) return "deny"
  if (/^(?:curl|Invoke-WebRequest|Invoke-RestMethod|scp|sftp|rsync)(?:\s|$)/i.test(text)) return "ask"
  if (/(?:encodedcommand|frombase64string|base64\s+-d)/i.test(text)) return "ask"
  if (/^(?:alias|function|Set-Alias|New-Alias)(?:\s|$)/i.test(text)) return "ask"
  if (/[$`%]|[?*[]/.test(text)) return "ask"
  if (/[{},]|@\(/.test(text)) return "ask"
  if (/[<|]/.test(text)) return "ask"

  if (/^git(?:\s|$)/i.test(text)) return classifyGit(text)
  const validation = classifyValidation(text)
  if (validation) return validation
  if (/^find(?:\s|$)/i.test(text)) {
    const options = Array.from(text.matchAll(/(?:^|\s)(-[A-Za-z][A-Za-z0-9-]*)/g), (match) => match[1])
    if (
      options.some(
        (value) =>
          ![
            "-H",
            "-L",
            "-P",
            "-name",
            "-iname",
            "-path",
            "-ipath",
            "-type",
            "-maxdepth",
            "-mindepth",
            "-empty",
            "-print",
            "-print0",
          ].includes(value),
      )
    )
      return "ask"
  }
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
  if (/(?:^|\s)--output(?:=|\s)/i.test(text)) return "deny"
  if (/(?:^|\s)(?:--ext-diff|--textconv|--contents|--filters)(?:=|\s|$)/i.test(text)) return "ask"
  const tokens = tokenize(text)
  if (!tokens?.length) return "ask"
  const command = tokens[0].toLowerCase()
  const args = tokens.slice(1)
  const separator = args.indexOf("--")
  const before = separator === -1 ? args : args.slice(0, separator)
  if (command === "status") {
    if (before.some((value) => !["--short", "-s", "--porcelain", "--branch", "-b", "--show-stash"].includes(value)))
      return "ask"
    return separator === -1 || separator < args.length - 1 ? "review" : "ask"
  }
  if (command === "log" || command === "show") {
    if (
      before.some(
        (value) =>
          !/^(?:--oneline|--stat|--name-only|--name-status|--decorate|-\d+|-n\d+|--max-count=\d+|--format=[^\r\n]+)$/.test(
            value,
          ),
      )
    )
      return "ask"
    return separator === -1 || separator < args.length - 1 ? "review" : "ask"
  }
  if (command === "diff") {
    if (before.some((value) => !/^(?:--no-index|--stat|--name-only|--name-status|--cached|--staged)$/.test(value)))
      return "ask"
    if (before.includes("--no-index")) return before.length === 1 && args.length === 3 ? "review" : "ask"
    return separator === -1 || separator < args.length - 1 ? "review" : "ask"
  }
  if (command === "blame")
    return separator !== -1 && before.length === 0 && separator < args.length - 1 ? "review" : "ask"
  if (command === "cat-file") return args.length === 2 && /^(?:-t|-s|-e|-p)$/.test(args[0]) ? "review" : "ask"
  if (command === "rev-parse")
    return args.length === 1 && /^(?:--show-toplevel|--show-prefix|--git-dir|--is-inside-work-tree|HEAD)$/.test(args[0])
      ? "review"
      : "ask"
  if (command === "ls-files")
    return args.length === 0 || (separator !== -1 && separator < args.length - 1) ? "review" : "ask"
  if (command === "ls-tree") return args.length === 1 && !args[0].startsWith("-") ? "review" : "ask"
  if (
    /^branch\s*$|^branch\s+(?:-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--list|-l)$|^branch\s+(?:--contains|--merged|--no-merged)(?:\s+\S+)?$/i.test(
      text,
    )
  )
    return "review"
  if (/^tag\s*$|^tag\s+(?:-n|-l|--list)$|^tag\s+(?:--contains|--points-at)(?:\s+\S+)?$/i.test(text)) return "review"
  if (
    /^stash\s+list$|^worktree\s+list(?:\s+--porcelain)?$|^config\s+(?:(?:--get|--get-all)\s+\S+|(?:--list|-l))$|^remote(?:\s*$|\s+-v$|\s+get-url\s+\S+?$)/i.test(
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

function classifyValidation(pattern: string): "review" | "ask" | "deny" | undefined {
  const tokens = tokenize(pattern)
  if (!tokens?.length) return
  const command = tokens[0].toLowerCase()
  if (command === "bun" && tokens[1] === "typecheck") return tokens.length === 2 ? "review" : "ask"
  if (command === "bun" && tokens[1] === "test") {
    if (
      tokens.some(
        (value) =>
          ["--preload", "--require", "--import", "-r", "--update-snapshots", "-u"].includes(value) ||
          ["--preload=", "--require=", "--import="].some((prefix) => value.startsWith(prefix)) ||
          (value.startsWith("-r") && value.length > 2),
      )
    )
      return "deny"
    if (tokens.slice(2).some((value) => value.startsWith("-"))) return "ask"
    return tokens.length > 2 ? "review" : "ask"
  }
  if (command === "go" && tokens[1] === "test") {
    if (
      tokens.some(
        (value) => value === "-o" || value.startsWith("-o=") || value === "-exec" || value.startsWith("-exec="),
      )
    )
      return "deny"
    if (tokens.slice(2).some((value) => value.startsWith("-"))) return "ask"
    return tokens.length > 2 ? "review" : "ask"
  }
  if (command === "cargo" && (tokens[1] === "check" || tokens[1] === "test")) {
    if (tokens.some((value) => value === "--target-dir" || value.startsWith("--target-dir="))) return "deny"
    const allowed = tokens
      .slice(2)
      .every((value, index, values) =>
        value === "--manifest-path" ? Boolean(values[index + 1]) : index > 0 && values[index - 1] === "--manifest-path",
      )
    return allowed ? "review" : "ask"
  }
  if (["npm", "pnpm", "yarn"].includes(command)) {
    const script = tokens[1] === "run" ? tokens[2] : tokens[1]
    if (!script || !["test", "lint", "typecheck"].includes(script)) return
    if (tokens.some((value) => value === "--output-file" || value.startsWith("--output-file="))) return "deny"
    const rest = tokens.slice(tokens[1] === "run" ? 3 : 2)
    if (script === "test") return "ask"
    if (rest.some((value) => value.startsWith("-"))) return "ask"
    return rest.length ? "ask" : "review"
  }
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
  if (command === "bun" && tokens[1] === "test")
    return tokens.length > 2 ? { type: "targets", values: tokens.slice(2) } : { type: "uncertain" }
  if (command === "go" && tokens[1] === "test")
    return tokens.length > 2 ? { type: "targets", values: tokens.slice(2) } : { type: "uncertain" }
  if (command === "cargo" && (tokens[1] === "check" || tokens[1] === "test")) {
    const index = tokens.indexOf("--manifest-path")
    if (index === -1) return { type: "none" }
    return tokens[index + 1] ? { type: "targets", values: [tokens[index + 1]] } : { type: "uncertain" }
  }
  if (["npm", "pnpm", "yarn"].includes(command)) return { type: "none" }
  if (command === "find") {
    const firstRoot = tokens.findIndex((value, index) => index > 0 && !["-H", "-L", "-P"].includes(value))
    const afterOptions = firstRoot === -1 ? tokens.length : firstRoot
    const delimiter = tokens[afterOptions] === "--"
    const start = delimiter ? afterOptions + 1 : afterOptions
    if (start === tokens.length) return start === 1 ? { type: "none" } : { type: "uncertain" }
    if (delimiter && tokens[start].startsWith("-")) return { type: "uncertain" }
    const expression = tokens.findIndex(
      (value, index) => index >= start && (value.startsWith("-") || value === "!" || value === "("),
    )
    const values = expression === -1 ? tokens.slice(start) : tokens.slice(start, expression)
    return values.length ? { type: "targets", values } : { type: "none" }
  }
  if (command === "git" && ["status", "log", "show", "diff", "blame", "ls-files"].includes(tokens[1]?.toLowerCase())) {
    const separator = tokens.indexOf("--")
    if (separator !== -1) {
      return tokens.length > separator + 1
        ? { type: "targets", values: tokens.slice(separator + 1) }
        : { type: "uncertain" }
    }
    if (tokens[1]?.toLowerCase() === "diff" && tokens.includes("--no-index")) {
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
