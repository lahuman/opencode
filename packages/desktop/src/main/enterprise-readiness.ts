import { execFile } from "node:child_process"
import { access, rm, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

export type EnterpriseReadinessStatus = "pass" | "warn" | "fail"
export type EnterpriseReadinessCheck = {
  id: string
  status: EnterpriseReadinessStatus
  code: string
  message: string
  detail?: string
}
export type EnterpriseProviderDiagnostic = {
  ok: boolean
  checks: {
    basic: "pass" | "fail" | "skipped"
    streaming: "pass" | "fail" | "skipped"
    toolCall: "pass" | "fail" | "skipped"
  }
  failure?: { kind: string; message: string }
}
export type EnterpriseReadinessReport = {
  schemaVersion: 1
  generatedAt: string
  overall: EnterpriseReadinessStatus
  checks: EnterpriseReadinessCheck[]
}

export function parseEnterpriseProviderDiagnostic(value: unknown): EnterpriseProviderDiagnostic | undefined {
  if (value === undefined) return
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isRecord(value.checks)) invalidDiagnostic()
  const basic = diagnosticStage(value.checks.basic)
  const streaming = diagnosticStage(value.checks.streaming)
  const toolCall = diagnosticStage(value.checks.toolCall)
  const passed = basic === "pass" && streaming === "pass" && toolCall === "pass"
  if (value.ok !== passed) invalidDiagnostic()
  if (basic !== "pass" && (streaming !== "skipped" || toolCall !== "skipped")) invalidDiagnostic()
  if (basic === "pass" && streaming !== "pass" && toolCall !== "skipped") invalidDiagnostic()
  if (value.ok && value.failure !== undefined) invalidDiagnostic()
  if (!value.ok && value.failure === undefined) invalidDiagnostic()
  if (value.failure === undefined) return { ok: value.ok, checks: { basic, streaming, toolCall } }
  if (!isRecord(value.failure) || typeof value.failure.kind !== "string") invalidDiagnostic()
  const kind = ["auth", "connection", "dns", "model", "response", "timeout", "tls"].includes(value.failure.kind)
    ? value.failure.kind
    : "response"
  return {
    ok: value.ok,
    checks: { basic, streaming, toolCall },
    failure: { kind, message: "Company LLM diagnostic failed" },
  }
}

export async function createEnterpriseReadinessReport(input: {
  packageVerified: boolean
  appDataWritable: () => Promise<boolean>
  encryptionAvailable: boolean
  credentialConfigured: boolean
  credentialError?: string
  findExecutable: (name: string) => Promise<boolean>
  provider?: EnterpriseProviderDiagnostic
  now?: () => Date
}): Promise<EnterpriseReadinessReport> {
  const appDataWritable = await input.appDataWritable()
  const tools = await Promise.all(
    ["git", "bun", "node", "python", "typescript-language-server", "pyright-langserver", "rust-analyzer", "clangd"].map(
      async (name) => ({ name, found: await input.findExecutable(name) }),
    ),
  )
  const runtime = tools.find((tool) => tool.found && ["bun", "node", "python"].includes(tool.name))
  const lsp = tools.find(
    (tool) =>
      tool.found && ["typescript-language-server", "pyright-langserver", "rust-analyzer", "clangd"].includes(tool.name),
  )
  const checks: EnterpriseReadinessCheck[] = [
    input.packageVerified
      ? { id: "package", status: "pass", code: "package_verified", message: "Enterprise package verified" }
      : { id: "package", status: "fail", code: "package_invalid", message: "Enterprise package verification failed" },
    appDataWritable
      ? { id: "appdata", status: "pass", code: "appdata_writable", message: "AppData is writable" }
      : { id: "appdata", status: "fail", code: "appdata_read_only", message: "AppData is not writable" },
    input.encryptionAvailable
      ? { id: "dpapi", status: "pass", code: "dpapi_available", message: "Windows credential encryption is available" }
      : { id: "dpapi", status: "fail", code: "dpapi_unavailable", message: "Windows credential encryption is unavailable" },
    input.credentialError
      ? {
          id: "credentials",
          status: "fail",
          code: input.credentialError,
          message: "Company LLM credentials must be re-entered",
        }
      : input.credentialConfigured
      ? { id: "credentials", status: "pass", code: "credentials_configured", message: "Company LLM credentials are configured" }
      : { id: "credentials", status: "warn", code: "credentials_missing", message: "Company LLM credentials must be entered" },
    ...providerChecks(input.provider),
    tools.find((tool) => tool.name === "git")?.found
      ? { id: "tool.git", status: "pass", code: "tool_git_found", message: "Git is available" }
      : { id: "tool.git", status: "warn", code: "tool_git_missing", message: "Git features are disabled until Git is installed" },
    runtime
      ? {
          id: "tool.runtime",
          status: "pass",
          code: "tool_runtime_found",
          message: "A supported local runtime is available",
          detail: runtime.name,
        }
      : {
          id: "tool.runtime",
          status: "warn",
          code: "tool_runtime_missing",
          message: "Runtime-dependent features are disabled until a runtime is installed",
        },
    lsp
      ? {
          id: "tool.lsp",
          status: "pass",
          code: "tool_lsp_found",
          message: "A local language server is available",
          detail: lsp.name,
        }
      : {
          id: "tool.lsp",
          status: "warn",
          code: "tool_lsp_missing",
          message: "Language features are disabled until an approved language server is installed",
        },
  ]
  return {
    schemaVersion: 1,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    overall: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "pass",
    checks,
  }
}

export async function checkEnterpriseAppData(path: string) {
  const probe = join(path, `.enterprise-readiness-${process.pid}-${Date.now()}`)
  return writeFile(probe, "", { flag: "wx" }).then(
    async () => {
      await rm(probe, { force: true })
      return true
    },
    () => false,
  )
}

export async function findEnterpriseExecutable(name: string) {
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) =>
      execFile("where.exe", [name], { timeout: 3000, windowsHide: true }, (error) => resolve(!error)),
    )
  }
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  return Promise.any(candidates.map((path) => access(join(path, name)).then(() => true))).catch(() => false)
}

function providerChecks(provider?: EnterpriseProviderDiagnostic): EnterpriseReadinessCheck[] {
  if (!provider) {
    return [
      pendingProviderCheck("llm.connection", "connection"),
      pendingProviderCheck("llm.authentication", "authentication"),
      pendingProviderCheck("llm.model", "model"),
      pendingProviderCheck("llm.streaming", "streaming"),
      pendingProviderCheck("llm.tool_call", "tool call"),
    ]
  }
  const failure = provider.failure?.kind
  const basic = (id: string, label: string, kinds: string[]): EnterpriseReadinessCheck => {
    if (provider.checks.basic === "pass")
      return { id, status: "pass", code: `${id.replace("llm.", "llm_")}_pass`, message: `Company LLM ${label} passed` }
    if (kinds.includes(failure ?? ""))
      return { id, status: "fail", code: `${id.replace("llm.", "llm_")}_fail`, message: `Company LLM ${label} failed` }
    return { id, status: "warn", code: `${id.replace("llm.", "llm_")}_skipped`, message: `Company LLM ${label} was not checked` }
  }
  const stage = (
    id: string,
    label: string,
    value: "pass" | "fail" | "skipped",
  ): EnterpriseReadinessCheck => ({
    id,
    status: value === "pass" ? "pass" : value === "fail" ? "fail" : "warn",
    code: `${id.replace("llm.", "llm_")}_${value}`,
    message: value === "pass" ? `Company LLM ${label} passed` : value === "fail" ? `Company LLM ${label} failed` : `Company LLM ${label} was not checked`,
  })
  return [
    basic("llm.connection", "connection", ["connection", "dns", "tls", "timeout", "response"]),
    basic("llm.authentication", "authentication", ["auth"]),
    basic("llm.model", "model", ["model"]),
    stage("llm.streaming", "streaming", provider.checks.streaming),
    stage("llm.tool_call", "tool call", provider.checks.toolCall),
  ]
}

function pendingProviderCheck(id: string, label: string): EnterpriseReadinessCheck {
  return {
    id,
    status: "warn",
    code: `${id.replace("llm.", "llm_")}_pending`,
    message: `Run the Company LLM diagnostic to check ${label}`,
  }
}

function diagnosticStage(value: unknown) {
  if (value === "pass" || value === "fail" || value === "skipped") return value
  return invalidDiagnostic()
}

function invalidDiagnostic(): never {
  throw new Error("Enterprise provider diagnostic is invalid")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
