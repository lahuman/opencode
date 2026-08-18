import { describe, expect, test } from "bun:test"

const enabledProfile = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
    { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
    { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
  ]),
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "sfmi-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
}

function evaluateConfig(env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(
    [
      "node",
      "--input-type=module",
      "--eval",
      `
        import { loadConfigFromFile } from "electron-vite"
        const loaded = await loadConfigFromFile(
          { command: "build", mode: "production" },
          "./electron.vite.config.ts",
        )
        process.stdout.write(JSON.stringify({
          main: loaded.config.main?.define,
          renderer: loaded.config.renderer?.define,
        }))
      `,
    ],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        OPENCODE_ENTERPRISE: "0",
        OPENCODE_ENTERPRISE_MODELS: "",
        OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "",
        ...env,
      },
    },
  )
  const stdout = new TextDecoder().decode(result.stdout)
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    ...(stdout
      ? { defines: JSON.parse(stdout) as Record<"main" | "renderer", Record<string, string>> }
      : {}),
  }
}

describe("enterprise Vite configuration", () => {
  test("loads ordinary configuration through Electron Vite's Node loader", () => {
    expect(evaluateConfig().exitCode).toBe(0)
  })

  test("defines enterprise versions for main and renderer", () => {
    expect(evaluateConfig(enabledProfile)).toMatchObject({
      exitCode: 0,
      defines: {
        main: {
          "import.meta.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION": JSON.stringify("pilot-1"),
          "import.meta.env.OPENCODE_ENTERPRISE_GUIDE_VERSION": JSON.stringify("sfmi-1"),
          "import.meta.env.OPENCODE_ENTERPRISE_CATALOG_VERSION": JSON.stringify("catalog-1"),
        },
        renderer: {
          "import.meta.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION": JSON.stringify("pilot-1"),
          "import.meta.env.OPENCODE_ENTERPRISE_GUIDE_VERSION": JSON.stringify("sfmi-1"),
          "import.meta.env.OPENCODE_ENTERPRISE_CATALOG_VERSION": JSON.stringify("catalog-1"),
        },
      },
    })
  })

  test.each([
    ["blank", ""],
    ["omitted", undefined],
  ])("defines an explicit empty Enterprise catalog with %s default for main and renderer", (_name, defaultModelID) => {
    expect(
      evaluateConfig({
        ...enabledProfile,
        OPENCODE_ENTERPRISE_MODELS: "[]",
        OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: defaultModelID,
      }),
    ).toMatchObject({
      exitCode: 0,
      defines: {
        main: {
          "import.meta.env.OPENCODE_ENTERPRISE_MODELS": JSON.stringify("[]"),
          "import.meta.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID": JSON.stringify(""),
        },
        renderer: {
          "import.meta.env.OPENCODE_ENTERPRISE_MODELS": JSON.stringify("[]"),
          "import.meta.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID": JSON.stringify(""),
        },
      },
    })
  })

  test("rejects a credentialed model URL before producing defines", () => {
    const result = evaluateConfig({
      ...enabledProfile,
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "company-code", name: "Company Code", baseURL: "https://user:secret@llm.corp.example/v1" },
      ]),
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("OPENCODE_ENTERPRISE_MODELS model URLs must not contain credentials")
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
