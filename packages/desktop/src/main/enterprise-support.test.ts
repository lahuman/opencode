import { describe, expect, test } from "bun:test"
import { createEnterpriseSupportManifest, redactEnterpriseSupportText } from "./enterprise-support"

describe("enterprise support bundle", () => {
  test("removes credentials, prompts, responses, source bodies, environment values, and secret headers", () => {
    const text = JSON.stringify({
      apiKey: "FAKE_API_KEY_14f15d",
      Authorization: "Bearer FAKE_AUTH_14f15d",
      prompt: "FAKE_PROMPT_14f15d",
      response: "FAKE_RESPONSE_14f15d",
      source: "FAKE_SOURCE_BODY_14f15d",
      safe: "error E_TIMEOUT",
      note: "FAKE_ENV_VALUE_14f15d",
      nested: { body: "FAKE_BODY_14f15d", token: "FAKE_TOKEN_14f15d" },
    })

    const redacted = redactEnterpriseSupportText(text, ["FAKE_ENV_VALUE_14f15d"])

    expect(redacted).toContain("E_TIMEOUT")
    for (const secret of ["FAKE_API", "FAKE_AUTH", "FAKE_PROMPT", "FAKE_RESPONSE", "FAKE_SOURCE", "FAKE_BODY", "FAKE_TOKEN"])
      expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain("FAKE_ENV_VALUE_14f15d")
  })

  test("manifest contains operational metadata without local paths or diagnostic failure messages", () => {
    const manifest = createEnterpriseSupportManifest({
      appVersion: "2.0.0",
      osBuild: "Windows 11 10.0.26100",
      generatedAt: "2026-07-16T00:00:00.000Z",
      readiness: {
        schemaVersion: 1,
        generatedAt: "2026-07-16T00:00:00.000Z",
        overall: "fail",
        checks: [
          { id: "llm.authentication", status: "fail", code: "llm_authentication_fail", message: "do not include" },
          { id: "tool.git", status: "warn", code: "tool_git_missing", message: "do not include", detail: "C:\\private\\git.exe" },
        ],
      },
      files: ["logs/main.log"],
    })

    expect(manifest).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-16T00:00:00.000Z",
      appVersion: "2.0.0",
      osBuild: "Windows 11 10.0.26100",
      readiness: {
        overall: "fail",
        checks: [
          { id: "llm.authentication", status: "fail", code: "llm_authentication_fail" },
          { id: "tool.git", status: "warn", code: "tool_git_missing" },
        ],
      },
      errorCodes: ["llm_authentication_fail"],
      toolApprovalMetadata: [],
      files: ["logs/main.log"],
      exclusions: ["prompts", "responses", "source", "environment-values", "secret-headers"],
    })
    expect(JSON.stringify(manifest)).not.toContain("private")
    expect(JSON.stringify(manifest)).not.toContain("do not include")
  })
})
