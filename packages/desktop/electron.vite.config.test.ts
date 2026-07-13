import { describe, expect, test } from "bun:test"

function evaluateConfig(env: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, "--eval", 'await import("./electron.vite.config.ts")'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      ...env,
    },
  })
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
}

describe("enterprise Vite configuration", () => {
  test("rejects a credentialed base URL before producing defines", () => {
    const result = evaluateConfig({ OPENCODE_ENTERPRISE_BASE_URL: "https://user:secret@llm.corp.example/v1" })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
  })

  test("rejects a credentialed allowed origin before producing defines", () => {
    const result = evaluateConfig({ OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://user:secret@llm-dr.corp.example" })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
  })
})
