import type { EnterpriseReadinessReport } from "./enterprise-readiness"

export type EnterpriseSupportManifestV1 = {
  schemaVersion: 1
  generatedAt: string
  appVersion: string
  osBuild: string
  readiness: {
    overall: "pass" | "warn" | "fail"
    checks: { id: string; status: "pass" | "warn" | "fail"; code: string }[]
  }
  errorCodes: string[]
  toolApprovalMetadata: { tool: string; decision: string; at: string }[]
  files: string[]
  exclusions: ["prompts", "responses", "source", "environment-values", "secret-headers"]
}

const excludedKeys = /^(prompt|prompts|response|responses|source|sourceCode|sourceId|content|body|environment|env|environmentVariables|error|stack|cause|message|line|path|url|currentURL|details|defaultProject)$/i
const secretKeys = /(api[_-]?key|authorization|cookie|credential|password|secret|token|x-api-key)/i

export function redactEnterpriseSupportText(text: string, secrets: string[]) {
  const known = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length)
  const redactKnown = (value: string) => known.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
  try {
    return JSON.stringify(redactValue(JSON.parse(text)), null, 2)
  } catch {
    return redactKnown(text)
      .replace(
        /\b(api[_-]?key|authorization|cookie|credential|password|prompt|response|secret|source|token|x-api-key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
        "$1=[REDACTED]",
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
  }

  function redactValue(value: unknown): unknown {
    if (typeof value === "string") return redactKnown(value)
    if (Array.isArray(value)) return value.map(redactValue)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (excludedKeys.test(key)) return []
        if (secretKeys.test(key)) return [[key, "[REDACTED]"]]
        return [[key, redactValue(item)]]
      }),
    )
  }
}

export function redactEnterpriseSupportMetadata(value: Record<string, unknown>, secrets: string[]) {
  return JSON.parse(redactEnterpriseSupportText(JSON.stringify(value), secrets)) as Record<string, unknown>
}

export function createEnterpriseSupportManifest(input: {
  appVersion: string
  osBuild: string
  generatedAt: string
  readiness: EnterpriseReadinessReport
  files: string[]
}): EnterpriseSupportManifestV1 {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    appVersion: input.appVersion,
    osBuild: input.osBuild,
    readiness: {
      overall: input.readiness.overall,
      checks: input.readiness.checks.map((check) => ({ id: check.id, status: check.status, code: check.code })),
    },
    errorCodes: input.readiness.checks.filter((check) => check.status === "fail").map((check) => check.code),
    toolApprovalMetadata: [],
    files: input.files,
    exclusions: ["prompts", "responses", "source", "environment-values", "secret-headers"],
  }
}
