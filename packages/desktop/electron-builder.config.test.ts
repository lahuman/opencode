import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  {
    channel: "dev",
    appId: "ai.opencode.desktop.dev",
    productName: "OpenCode Dev",
    protocols: { name: "OpenCode", schemes: ["opencode"] },
    publish: undefined,
  },
  {
    channel: "beta",
    appId: "ai.opencode.desktop.beta",
    productName: "OpenCode Beta",
    protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
    publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
  },
  {
    channel: "prod",
    appId: "ai.opencode.desktop",
    productName: "OpenCode",
    protocols: { name: "OpenCode", schemes: ["opencode"] },
    publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
  },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    const previousEnterprise = process.env.OPENCODE_ENTERPRISE
    const previousCSCLink = process.env.CSC_LINK
    const previousCSCKeyPassword = process.env.CSC_KEY_PASSWORD
    process.env.OPENCODE_CHANNEL = channel.channel
    process.env.OPENCODE_ENTERPRISE = "0"
    delete process.env.CSC_LINK
    delete process.env.CSC_KEY_PASSWORD

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous
    if (previousEnterprise === undefined) delete process.env.OPENCODE_ENTERPRISE
    else process.env.OPENCODE_ENTERPRISE = previousEnterprise
    if (previousCSCLink === undefined) delete process.env.CSC_LINK
    else process.env.CSC_LINK = previousCSCLink
    if (previousCSCKeyPassword === undefined) delete process.env.CSC_KEY_PASSWORD
    else process.env.CSC_KEY_PASSWORD = previousCSCKeyPassword

    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(channel.productName)
    expect(config.artifactName).toBe("opencode-desktop-${os}-${arch}.${ext}")
    expect(config.protocols).toEqual(channel.protocols)
    expect(config.publish).toEqual(channel.publish)
    expect(config.win?.signtoolOptions?.sign).toBeFunction()
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  const previousEnterprise = process.env.OPENCODE_ENTERPRISE
  process.env.OPENCODE_CHANNEL = "prod"
  process.env.OPENCODE_ENTERPRISE = "0"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous
  if (previousEnterprise === undefined) delete process.env.OPENCODE_ENTERPRISE
  else process.env.OPENCODE_ENTERPRISE = previousEnterprise

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("packages enterprise defaults and guide beside app.asar", async () => {
  const previous = process.env.OPENCODE_ENTERPRISE
  process.env.OPENCODE_ENTERPRISE = "0"

  const module = await import("./electron-builder.config.ts?enterprise=resources")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_ENTERPRISE
  else process.env.OPENCODE_ENTERPRISE = previous

  expect(config.extraResources).toContainEqual({
    from: "resources/enterprise",
    to: "enterprise",
  })
  expect(config.extraResources).toContainEqual(
    expect.objectContaining({
      from: "native/",
      to: "native/",
    }),
  )
  expect(config.extraResources).toHaveLength(2)
  expect(
    await Promise.all(
      ["opencode.jsonc", "company-guide.md"].map((file) => Bun.file(`resources/enterprise/${file}`).exists()),
    ),
  ).toEqual([true, true])
})

test("direct enterprise builder imports cannot bypass package preflight", async () => {
  const keys = [
    "OPENCODE_ENTERPRISE",
    "OPENCODE_ENTERPRISE_BASE_URL",
    "OPENCODE_ENTERPRISE_MODEL_ID",
    "OPENCODE_ENTERPRISE_MODEL_NAME",
    "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
    "OPENCODE_ENTERPRISE_DEFAULTS_VERSION",
    "OPENCODE_ENTERPRISE_GUIDE_VERSION",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
    OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
    OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
    CSC_KEY_PASSWORD: "set",
  })
  delete process.env.CSC_LINK

  await expect(
    import("./electron-builder.config.ts?enterprise=preflight").finally(() => {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) {
          delete process.env[key]
          continue
        }
        process.env[key] = value
      }
    }),
  ).rejects.toThrow("CSC_LINK")
})

test("enterprise pilot uses an isolated signed Windows identity without a publisher", async () => {
  const keys = [
    "OPENCODE_CHANNEL",
    "OPENCODE_ENTERPRISE",
    "OPENCODE_ENTERPRISE_BASE_URL",
    "OPENCODE_ENTERPRISE_MODEL_ID",
    "OPENCODE_ENTERPRISE_MODEL_NAME",
    "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
    "OPENCODE_ENTERPRISE_DEFAULTS_VERSION",
    "OPENCODE_ENTERPRISE_GUIDE_VERSION",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    OPENCODE_CHANNEL: "prod",
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
    OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
    OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
    CSC_LINK: "C:/signing/company.pfx",
    CSC_KEY_PASSWORD: "set",
  })

  const config = await import("./electron-builder.config.ts?enterprise=pilot")
    .then((module) => module.default as Configuration)
    .finally(() => {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) {
          delete process.env[key]
          continue
        }
        process.env[key] = value
      }
    })

  expect(config.appId).toBe("com.company.opencode.pilot")
  expect(config.productName).toBe("Company OpenCode Pilot")
  expect(config.artifactName).toBe("company-opencode-pilot-${os}-${arch}.${ext}")
  expect(config.publish).toBeUndefined()
  expect(config.protocols).toBeUndefined()
  expect(config.win?.target).toEqual(["nsis"])
  expect(config.win?.signtoolOptions).toBeUndefined()
  expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false })
  expect(config.extraResources).toContainEqual({ from: "../../LICENSE", to: "licenses/OpenCode-LICENSE" })
  expect(
    config.extraResources?.filter(
      (resource) => typeof resource === "object" && resource.from === "resources/enterprise",
    ),
  ).toHaveLength(1)
  expect(
    config.extraResources?.filter(
      (resource) => typeof resource === "object" && resource.to === "licenses/OpenCode-LICENSE",
    ),
  ).toHaveLength(1)
})
