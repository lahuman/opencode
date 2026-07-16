import { describe, expect, test } from "bun:test"
import { createEnterpriseReadinessReport, parseEnterpriseProviderDiagnostic } from "./enterprise-readiness"

describe("enterprise readiness", () => {
  test("accepts only bounded provider diagnostic IPC data and discards renderer messages", () => {
    expect(
      parseEnterpriseProviderDiagnostic({
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: { kind: "auth", message: "api-key-secret-marker" },
      }),
    ).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: { kind: "auth", message: "Company LLM diagnostic failed" },
    })
    expect(() => parseEnterpriseProviderDiagnostic({ checks: {} })).toThrow("diagnostic is invalid")
    expect(() =>
      parseEnterpriseProviderDiagnostic({
        ok: true,
        checks: { basic: "forged", streaming: "pass", toolCall: "pass" },
      }),
    ).toThrow("diagnostic is invalid")
    expect(() =>
      parseEnterpriseProviderDiagnostic({
        ok: false,
        checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
        failure: { kind: "auth", message: "forged" },
      }),
    ).toThrow("diagnostic is invalid")
  })

  test("reports local prerequisites and a successful provider diagnostic", async () => {
    const report = await createEnterpriseReadinessReport({
      packageVerified: true,
      appDataWritable: async () => true,
      encryptionAvailable: true,
      credentialConfigured: true,
      findExecutable: async (name) => ["git", "node", "typescript-language-server"].includes(name),
      provider: {
        ok: true,
        checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
      },
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    })

    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-16T00:00:00.000Z",
      overall: "pass",
      checks: [
        { id: "package", status: "pass", code: "package_verified", message: "Enterprise package verified" },
        { id: "appdata", status: "pass", code: "appdata_writable", message: "AppData is writable" },
        { id: "dpapi", status: "pass", code: "dpapi_available", message: "Windows credential encryption is available" },
        { id: "credentials", status: "pass", code: "credentials_configured", message: "Company LLM credentials are configured" },
        { id: "llm.connection", status: "pass", code: "llm_connection_pass", message: "Company LLM connection passed" },
        { id: "llm.authentication", status: "pass", code: "llm_authentication_pass", message: "Company LLM authentication passed" },
        { id: "llm.model", status: "pass", code: "llm_model_pass", message: "Company LLM model passed" },
        { id: "llm.streaming", status: "pass", code: "llm_streaming_pass", message: "Company LLM streaming passed" },
        { id: "llm.tool_call", status: "pass", code: "llm_tool_call_pass", message: "Company LLM tool call passed" },
        { id: "tool.git", status: "pass", code: "tool_git_found", message: "Git is available" },
        { id: "tool.runtime", status: "pass", code: "tool_runtime_found", message: "A supported local runtime is available", detail: "node" },
        { id: "tool.lsp", status: "pass", code: "tool_lsp_found", message: "A local language server is available", detail: "typescript-language-server" },
      ],
    })
  })

  test("fails closed for DPAPI and classifies authentication while warning for missing optional tools", async () => {
    const report = await createEnterpriseReadinessReport({
      packageVerified: true,
      appDataWritable: async () => true,
      encryptionAvailable: false,
      credentialConfigured: false,
      credentialError: "credential_decryption_failed",
      findExecutable: async () => false,
      provider: {
        ok: false,
        checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
        failure: { kind: "auth", message: "sanitized" },
      },
    })

    expect(report.overall).toBe("fail")
    expect(report.checks.find((check) => check.id === "dpapi")).toMatchObject({ status: "fail", code: "dpapi_unavailable" })
    expect(report.checks.find((check) => check.id === "credentials")).toMatchObject({ status: "fail", code: "credential_decryption_failed" })
    expect(report.checks.find((check) => check.id === "llm.authentication")).toMatchObject({ status: "fail", code: "llm_authentication_fail" })
    expect(report.checks.find((check) => check.id === "llm.connection")).toMatchObject({ status: "warn" })
    expect(report.checks.find((check) => check.id === "tool.git")).toMatchObject({ status: "warn" })
    expect(JSON.stringify(report)).not.toContain("sanitized")
  })
})
