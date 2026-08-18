import { expect, test } from "bun:test"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"
const enterprise = {
  OPENCODE_CHANNEL: "prod",
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "sfmi-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
}

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
  test(`loads ${channel.channel} through electron-builder's Jiti loader`, () => {
    const result = evaluateConfig({ OPENCODE_CHANNEL: channel.channel })

    expect(result.exitCode).toBe(0)
    expect(result.summary).toMatchObject({
      appId: channel.appId,
      productName: channel.productName,
      artifactName: "opencode-desktop-${os}-${arch}.${ext}",
      protocols: channel.protocols,
      ordinarySignFunction: true,
      standardCSC: false,
      desktopName: `${channel.appId}.desktop`,
      linuxExecutableName: channel.appId,
      startupWMClass: channel.appId,
    })
    expect(result.summary?.publish).toEqual(channel.publish)
    expect(result.summary?.debFpm).toContainEqual(
      expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`),
    )
    expect(result.summary?.rpmFpm).toContainEqual(
      expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`),
    )
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const result = evaluateConfig({ OPENCODE_CHANNEL: "prod" })

  expect(result.exitCode).toBe(0)
  expect(
    result.summary?.debFpm?.some((entry: string) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    result.summary?.rpmFpm?.some((entry: string) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("keeps ordinary resource packaging unchanged", async () => {
  const result = evaluateConfig()

  expect(result.exitCode).toBe(0)
  expect(result.summary?.extraResources).toContainEqual({
    from: "resources/enterprise",
    to: "enterprise",
  })
  expect(result.summary?.extraResources).toContainEqual({ from: "native/", to: "native/" })
  expect(result.summary?.extraResources).toHaveLength(2)
  expect(
    await Promise.all(
      ["opencode.jsonc", "company-guide.md"].map((file) => Bun.file(`resources/enterprise/${file}`).exists()),
    ),
  ).toEqual([true, true])
})

test("loads a portable unsigned enterprise ZIP configuration", () => {
  const result = evaluateConfig(enterprise)

  expect(result.exitCode).toBe(0)
  expect(result.summary).toMatchObject({
    appId: "com.company.sfmi",
    productName: "SFMI",
    artifactName: "sfmi-${version}-${os}-${arch}.${ext}",
    winTarget: ["zip"],
    ordinarySignFunction: false,
    standardCSC: true,
    beforePack: false,
  })
  expect(result.summary?.cscLink).toBeUndefined()
  expect(result.summary?.nsis).toBeUndefined()
  expect(result.summary?.publish).toBeUndefined()
  expect(result.summary?.protocols).toBeUndefined()
  expect(result.summary?.extraResources).toContainEqual({
    from: "../../LICENSE",
    to: "licenses/OpenCode-LICENSE",
  })
})

test("does not consume inherited signing values in the enterprise builder config", () => {
  const markers = ["csc-link-secret-marker", "csc-password-secret-marker", "win-csc-secret-marker"]
  const result = evaluateConfig({
    ...enterprise,
    CSC_LINK: markers[0],
    CSC_KEY_PASSWORD: markers[1],
    WIN_CSC_LINK: markers[2],
  })

  expect(result.exitCode).toBe(0)
  expect(result.summary?.cscLink).toBeUndefined()
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(markers[0])
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(markers[1])
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(markers[2])
})

test("validates enterprise inputs during direct builder loading", () => {
  const result = evaluateConfig({ ...enterprise, OPENCODE_ENTERPRISE_BASE_URL: "not-a-url" })

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("OPENCODE_ENTERPRISE_BASE_URL")
})

test("isolated builder scenarios leave the parent environment untouched", () => {
  const keys = ["OPENCODE_CHANNEL", "OPENCODE_ENTERPRISE", "CSC_LINK", "CSC_KEY_PASSWORD"] as const
  const before = keys.map((key) => process.env[key])

  expect(evaluateConfig({ OPENCODE_CHANNEL: "beta" }).exitCode).toBe(0)
  expect(keys.every((key, index) => process.env[key] === before[index])).toBeTrue()
})

function evaluateConfig(env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync([process.execPath, "test/electron-builder-config-entrypoint.ts"], {
    cwd: import.meta.dir,
    env: builderEnvironment(env),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(result.stdout).trim()
  const summary = stdout.split(/\r?\n/).find((line) => line.startsWith("OPENCODE_TEST_RESULT:"))
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: new TextDecoder().decode(result.stderr),
    summary: summary ? JSON.parse(summary.slice("OPENCODE_TEST_RESULT:".length)) : undefined,
  }
}

function builderEnvironment(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCODE_CHANNEL: "dev",
    OPENCODE_ENTERPRISE: "0",
    OPENCODE_ENTERPRISE_MODELS: "",
    OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
    ...env,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
