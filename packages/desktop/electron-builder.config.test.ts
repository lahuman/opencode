import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"
const passwordMarker = "password-secret-marker"
const enterprise = {
  OPENCODE_CHANNEL: "prod",
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
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
  test(`loads ${channel.channel} through electron-builder's Jiti loader without enterprise signing inputs`, () => {
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
      certificateStaged: false,
      cleanupRegistered: false,
    })
    expect(result.summary?.publish).toEqual(channel.publish)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const result = evaluateConfig({ OPENCODE_CHANNEL: "prod" })

  expect(result.exitCode).toBe(0)
  expect(result.summary?.debFpm?.[0]).toEndWith(
    `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`,
  )
  expect(result.summary?.rpmFpm?.[0]).toEndWith(
    `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`,
  )

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("ordinary resource packaging does not stage or require a certificate", async () => {
  const result = evaluateConfig()

  expect(result.exitCode).toBe(0)
  expect(result.summary?.extraResources).toContainEqual({
    from: "resources/enterprise",
    to: "enterprise",
  })
  expect(result.summary?.extraResources).toContainEqual({ from: "native/", to: "native/" })
  expect(result.summary?.extraResources).toHaveLength(2)
  expect(result.summary).toMatchObject({ certificateStaged: false, cleanupRegistered: false })
  expect(
    await Promise.all(
      ["opencode.jsonc", "company-guide.md"].map((file) => Bun.file(`resources/enterprise/${file}`).exists()),
    ),
  ).toEqual([true, true])
})

test("direct enterprise builder loading cannot bypass package preflight", () => {
  const result = evaluateConfig({ ...enterprise, CSC_KEY_PASSWORD: passwordMarker })

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("CSC_LINK")
  expectDiagnosticsSafe(result, [passwordMarker])
})

test("rejects unreadable secret-bearing certificate paths without diagnostic disclosure", () => {
  const pathMarker = "csc-path-secret-marker"
  const basenameMarker = "certificate-basename-secret-marker.pfx"
  const result = evaluateConfig({
    ...enterprise,
    CSC_LINK: path.join(tmpdir(), pathMarker, basenameMarker),
    CSC_KEY_PASSWORD: passwordMarker,
  })

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("CSC_LINK must reference an existing readable local PFX certificate file")
  expectDiagnosticsSafe(result, [pathMarker, basenameMarker, passwordMarker])
})

test("rejects URL, data, base64, and relative certificate forms with fixed errors", () => {
  for (const cscLink of [
    "https://signing.example/url-secret-marker.pfx",
    "data:application/x-pkcs12;base64,data-secret-marker",
    "base64-secret-marker",
    "relative-certificate-secret-marker.pfx",
  ]) {
    const result = evaluateConfig({
      ...enterprise,
      CSC_LINK: cscLink,
      CSC_KEY_PASSWORD: passwordMarker,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("CSC_LINK must reference an existing readable local PFX certificate file")
    expectDiagnosticsSafe(result, [
      "url-secret-marker",
      "data-secret-marker",
      "base64-secret-marker",
      "relative-certificate-secret-marker",
      passwordMarker,
    ])
  }
})

test("stages an opaque restricted certificate and preserves enterprise installer behavior", async () => {
  await withCertificate(async (certificate) => {
    const result = evaluateConfig({
      ...enterprise,
      CSC_LINK: certificate,
      CSC_KEY_PASSWORD: passwordMarker,
    })

    expect(result.exitCode).toBe(0)
    expectDiagnosticsSafe(result, [
      path.basename(path.dirname(certificate)),
      path.basename(certificate),
      passwordMarker,
    ])
    expect(result.summary).toMatchObject({
      appId: "com.company.opencode.pilot",
      productName: "Company OpenCode Pilot",
      artifactName: "company-opencode-pilot-${os}-${arch}.${ext}",
      winTarget: ["nsis"],
      ordinarySignFunction: false,
      standardCSC: true,
      nsis: { oneClick: true, perMachine: false },
      certificateStaged: true,
      certificateExists: true,
      certificateRestricted: true,
      certificateOpaque: true,
      cleanupRegistered: true,
      cleanupComplete: true,
      serializedHidesOriginal: true,
      serializedHidesPassword: true,
    })
    expect(result.summary?.publish).toBeUndefined()
    expect(result.summary?.protocols).toBeUndefined()
    expect(result.summary?.extraResources).toContainEqual({
      from: "../../LICENSE",
      to: "licenses/OpenCode-LICENSE",
    })
    expect(
      result.summary?.extraResources.filter(
        (resource: { from?: string; to?: string }) => resource.from === "resources/enterprise",
      ),
    ).toHaveLength(1)
    expect(
      result.summary?.extraResources.filter(
        (resource: { from?: string; to?: string }) => resource.to === "licenses/OpenCode-LICENSE",
      ),
    ).toHaveLength(1)
    expect(await Bun.file(certificate).exists()).toBeTrue()
  })
})

test("removes the opaque certificate on process exit before a packager hook runs", async () => {
  await withCertificate(async (certificate) => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-builder-result-"))
    const resultPath = path.join(directory, "staged-path.txt")

    try {
      const result = evaluateConfig({
        ...enterprise,
        CSC_LINK: certificate,
        CSC_KEY_PASSWORD: passwordMarker,
        OPENCODE_TEST_BUILDER_SCENARIO: "exit",
        OPENCODE_TEST_RESULT_PATH: resultPath,
      })
      const stagedPath = await Bun.file(resultPath).text()

      expect(result.exitCode).toBe(0)
      expectDiagnosticsSafe(result, [
        path.basename(path.dirname(certificate)),
        path.basename(certificate),
        passwordMarker,
      ])
      expect(stagedPath.length > 0).toBeTrue()
      expect(path.basename(stagedPath)).toBe("certificate.pfx")
      expect(await Bun.file(stagedPath).exists()).toBeFalse()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("removes the opaque certificate through the packager failure disposer before process exit", async () => {
  await withCertificate(async (certificate) => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-builder-result-"))
    const resultPath = path.join(directory, "cleanup.json")

    try {
      const result = evaluateConfig({
        ...enterprise,
        CSC_LINK: certificate,
        CSC_KEY_PASSWORD: passwordMarker,
        OPENCODE_TEST_BUILDER_SCENARIO: "packager-error",
        OPENCODE_TEST_RESULT_PATH: resultPath,
      })
      const cleanup = await Bun.file(resultPath).json()

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("Simulated packager failure")
      expectDiagnosticsSafe(result, [
        path.basename(path.dirname(certificate)),
        path.basename(certificate),
        passwordMarker,
      ])
      expect(cleanup).toMatchObject({ cleanupRegistered: true, cleanupComplete: true })
      expect(cleanup.stagedPath.length > 0).toBeTrue()
      expect(await Bun.file(cleanup.stagedPath).exists()).toBeFalse()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
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
    env: {
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
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(result.stdout).trim()
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: new TextDecoder().decode(result.stderr),
    summary: stdout ? JSON.parse(stdout) : undefined,
  }
}

function expectDiagnosticsSafe(result: { stdout: string; stderr: string }, markers: Array<string | undefined>) {
  const diagnostics = `${result.stdout}\n${result.stderr}`
  expect(markers.filter(Boolean).some((marker) => marker && diagnostics.includes(marker))).toBeFalse()
}

async function withCertificate<T>(run: (certificate: string) => T | Promise<T>) {
  const directory = await mkdtemp(path.join(tmpdir(), "csc-path-secret-marker-"))
  const certificate = path.join(directory, "certificate-basename-secret-marker.pfx")
  await Bun.write(certificate, "test certificate")
  try {
    return await run(certificate)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
