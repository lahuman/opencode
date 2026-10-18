import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Configuration } from "electron-builder"
import { getConfig } from "./electron-builder.config"
import { CLI_BINARIES, nodePtyPackage } from "./scripts/utils"

// Use electron-builder's matcher so the tests also cover its glob and directory traversal semantics.
const { FileMatcher } = createRequire(import.meta.resolve("electron-builder"))("app-builder-lib/out/fileMatcher")

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

function load(channel: string, target?: string): Configuration {
  const previous = process.env.OPENCODE_CHANNEL
  const previousTarget = process.env.OPENCODE_CLI_TARGET
  const previousEnterprise = process.env.OPENCODE_ENTERPRISE
  process.env.OPENCODE_ENTERPRISE = "0"
  process.env.OPENCODE_CHANNEL = channel

  if (target !== undefined) process.env.OPENCODE_CLI_TARGET = target
  else delete process.env.OPENCODE_CLI_TARGET

  try {
    return getConfig()
  } finally {
    if (previousEnterprise === undefined) delete process.env.OPENCODE_ENTERPRISE
    else process.env.OPENCODE_ENTERPRISE = previousEnterprise
    delete process.env.OPENCODE_CHANNEL
    delete process.env.OPENCODE_CLI_TARGET

    if (previous !== undefined) process.env.OPENCODE_CHANNEL = previous

    if (previousTarget !== undefined) process.env.OPENCODE_CLI_TARGET = previousTarget
  }
}

function trimFilter(dir: string, config: Configuration) {
  const patterns = Array.isArray(config.files) ? config.files.flatMap((value) => (value ? [String(value)] : [])) : []

  return new FileMatcher(dir, "", (value: string) => value, [
    "**/*",
    ...patterns.filter((value) => value.startsWith("!")),
  ]).createFilter()
}

test.each(channels)("channel identity for $channel", ({ channel, appId }) => {
  const config = load(channel)
  expect(config.appId).toBe(appId)
  expect(config.extraMetadata?.desktopName).toBe(`${appId}.desktop`)
  expect(config.linux?.executableName).toBe(appId)
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(appId)

  for (const fpm of [config.deb?.fpm, config.rpm?.fpm]) {
    expect(fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${appId}.metainfo.xml`))
    expect(
      fpm?.some((entry) => entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop")),
    ).toBe(channel === "prod")
  }
})

test("legacy Linux launcher stays hidden", async () => {
  const desktop = await Bun.file(path.join(import.meta.dirname, "resources/linux/opencode-desktop.desktop")).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("shared packaging defaults", async () => {
  const config = load("dev")
  expect(config.mac?.sign).toBeFunction()
  expect(config.dmg?.sign).not.toBe(true)
  expect(config.mac?.extendInfo?.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac).toBe(true)
  const include = path.join(import.meta.dirname, "resources/windows/installer.nsh")
  expect(config.nsis?.include).toBe(include)
  expect(await Bun.file(include).exists()).toBe(true)
  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toEqual([
    { from: "resources/", to: "", filter: ["opencode-cli", "opencode-cli.exe", "opencode-cli.version"] },
  ])
})

test("trims external dependencies without excluding runtime files", () => {
  const fileStats = statSync(import.meta.filename)
  const dirStats = statSync(import.meta.dirname)
  const filter = trimFilter(import.meta.dirname, load("dev"))

  for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
    const included = (file: string, stats = fileStats) => filter(path.join(import.meta.dirname, prefix, file), stats)

    // One file for each excluded pattern, including each brace alternative.
    for (const file of [
      "@zip.js/zip.js/dist/zip.js",
      ...["index.cjs", "index.min.js", "index-fflate.js", "deno.json", "eslint.config.mjs"].map(
        (name) => `@zip.js/zip.js/${name}`,
      ),
      ...["d.ts", "d.cts", "d.mts", "d.ts.map", "d.cts.map", "d.mts.map", "js.map", "cjs.map", "mjs.map"].map(
        (extension) => `unrelated/dist/index.${extension}`,
      ),
      "ajv/lib/core.ts",
      "ajv-formats/src/formats.ts",
      "js-yaml/dist/js-yaml.js",
      "js-yaml/dist/js-yaml.min.js",
      "js-yaml/dist/js-yaml.mjs.map",
      "js-yaml/bin/js-yaml.js",
    ]) {
      expect(included(file)).toBe(false)
    }

    for (const file of [
      "@zip.js/zip.js/index.js",
      "@zip.js/zip.js/lib/z-worker-inline.js",
      "electron-updater/out/main.js",
      "electron-updater/out/MacUpdater.js",
      "electron-updater/out/NsisUpdater.js",
      "electron-updater/out/providers/GitHubProvider.js",
      "builder-util-runtime/out/httpExecutor.js",
      "ajv/dist/ajv.js",
      "ajv/dist/refs/json-schema-draft-07.json",
      "ajv-formats/dist/formats.js",
      "js-yaml/index.js",
      "js-yaml/dist/js-yaml.mjs",
      "unrelated/dist/index.js",
      "unrelated/dist/index.cjs",
      "unrelated/dist/data.json",
      "unrelated/src/index.ts",
      ...["@zip.js/zip.js", "electron-updater", "builder-util-runtime", "ajv", "ajv-formats", "js-yaml"].flatMap(
        (name) => [`${name}/package.json`, `${name}/LICENSE`],
      ),
    ]) {
      expect(included(file)).toBe(true)
    }

    expect(included("@zip.js/zip.js/dist", dirStats)).toBe(false)
    expect(included("@zip.js/zip.js/lib", dirStats)).toBe(true)
  }

  for (const item of CLI_BINARIES) {
    const targetFilter = trimFilter(import.meta.dirname, load("prod", item.target))
    const active = nodePtyPackage(item.target)

    for (const candidate of CLI_BINARIES) {
      const pkg = nodePtyPackage(candidate.target)
      const included = targetFilter(path.join(import.meta.dirname, "node_modules", pkg, "lib/index.js"), fileStats)
      expect(included).toBe(pkg === active)
    }
  }
})

test("the trimmed Zip.js package can still export compressed logs", async () => {
  const config = load("dev")
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-zip-package-"))
  const source = path.dirname(fileURLToPath(import.meta.resolve("@zip.js/zip.js/package.json")))
  const filter = trimFilter(dir, config)

  try {
    await cp(source, dir, {
      recursive: true,
      filter: (file) =>
        filter(path.join(dir, "node_modules/@zip.js/zip.js", path.relative(source, file)), statSync(file)),
    })
    const zip = await import(pathToFileURL(path.join(dir, "index.js")).href)
    const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"))
    await writer.add("desktop.log", new zip.BlobReader(new Blob(["diagnostic log\n".repeat(100)])))
    const reader = new zip.ZipReader(new zip.BlobReader(await writer.close()))
    const entries = await reader.getEntries()
    expect(entries.map((entry: { filename: string }) => entry.filename)).toEqual(["desktop.log"])
    expect(entries[0].compressionMethod).toBe(8)
    expect(await entries[0].getData(new zip.TextWriter())).toBe("diagnostic log\n".repeat(100))
    await reader.close()
    await zip.terminateWorkers()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const enterprise = {
  OPENCODE_CHANNEL: "prod",
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "chai-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
}

test("loads a portable unsigned enterprise ZIP configuration", () => {
  const result = evaluateConfig(enterprise)

  expect(result.exitCode).toBe(0)
  expect(result.summary).toMatchObject({
    appId: "com.company.sfmi",
    productName: "CHAI",
    artifactName: "chai-${version}-${os}-${arch}.${ext}",
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
