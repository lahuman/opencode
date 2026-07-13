import { describe, expect, test } from "bun:test"

const enabledProfile = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
}

function evaluateConfig(env: Record<string, string> = {}) {
  const result = Bun.spawnSync(
    [
      "node",
      "--input-type=module",
      "--eval",
      'import { loadConfigFromFile } from "electron-vite"; const config = await loadConfigFromFile({ command: "build", mode: "production" }, "./electron.vite.config.ts"); if (!config) process.exitCode = 1',
    ],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        OPENCODE_ENTERPRISE: "0",
        OPENCODE_ENTERPRISE_BASE_URL: "",
        OPENCODE_ENTERPRISE_MODEL_ID: "",
        OPENCODE_ENTERPRISE_MODEL_NAME: "",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "",
        ...env,
      },
    },
  )
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
}

describe("enterprise Vite configuration", () => {
  test("loads ordinary configuration through Electron Vite's Node loader", () => {
    expect(evaluateConfig().exitCode).toBe(0)
  })

  test("rejects a credentialed base URL before producing defines", () => {
    const result = evaluateConfig({
      ...enabledProfile,
      OPENCODE_ENTERPRISE_BASE_URL: "https://user:secret@llm.corp.example/v1",
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
  })

  test("rejects a credentialed allowed origin before producing defines", () => {
    const result = evaluateConfig({
      ...enabledProfile,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://user:secret@llm-dr.corp.example",
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
  })
})
