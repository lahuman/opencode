import { createRequire } from "node:module"
import path from "node:path"
import { stat } from "node:fs/promises"

const require = createRequire(import.meta.url)
const resultPrefix = "OPENCODE_TEST_RESULT:"
const electronBuilder = require.resolve("electron-builder")
const loaderPath = require.resolve("app-builder-lib/out/util/config/config", {
  paths: [path.dirname(electronBuilder)],
})
const loader = require(loaderPath)
const originalLink = process.env.CSC_LINK
const originalPassword = process.env.CSC_KEY_PASSWORD
const projectDir = path.resolve(import.meta.dir, "..")
const config = await loader.getConfig(
  projectDir,
  "electron-builder.config.ts",
  process.env.OPENCODE_TEST_BUILDER_OVERRIDE ? JSON.parse(process.env.OPENCODE_TEST_BUILDER_OVERRIDE) : null,
)

const stagedLink = process.env.CSC_LINK
const certificateStaged = Boolean(originalLink && stagedLink && originalLink !== stagedLink)
const certificateExists = certificateStaged && stagedLink ? await Bun.file(stagedLink).exists() : false
const certificateRestricted =
  !certificateStaged ||
  process.platform === "win32" ||
  (stagedLink ? ((await stat(stagedLink)).mode & 0o777) === 0o600 : false)
const certificateOpaque = Boolean(
  certificateStaged &&
    stagedLink &&
    path.basename(stagedLink) === "certificate.pfx" &&
    originalLink &&
    !stagedLink.includes(path.basename(originalLink)),
)
const serialized = JSON.stringify(config)
const serializedHidesOriginal = !originalLink || !serialized.includes(originalLink)
const serializedHidesPassword = !originalPassword || !serialized.includes(originalPassword)

if (process.env.OPENCODE_TEST_BUILDER_SCENARIO === "exit") {
  if (!process.env.OPENCODE_TEST_RESULT_PATH) throw new Error("Builder test result path is required")
  await Bun.write(
    process.env.OPENCODE_TEST_RESULT_PATH,
    certificateStaged && certificateOpaque && stagedLink ? stagedLink : "",
  )
  process.stdout.write(`${resultPrefix}${JSON.stringify({ certificateStaged, certificateOpaque })}`)
  process.exit(0)
}

if (process.env.OPENCODE_TEST_BUILDER_SCENARIO === "signal") {
  if (!process.env.OPENCODE_TEST_RESULT_PATH) throw new Error("Builder test result path is required")
  await Bun.write(
    process.env.OPENCODE_TEST_RESULT_PATH,
    certificateStaged && certificateOpaque && stagedLink ? stagedLink : "",
  )
  process.stdout.write(`${resultPrefix}${JSON.stringify({ certificateStaged, certificateOpaque })}`)
  await new Promise<void>(() => setInterval(() => undefined, 1_000))
}

const disposers: Array<() => Promise<void>> = []
if (typeof config.beforePack === "function") {
  await config.beforePack({
    packager: {
      config,
      platformSpecificBuildOptions: config.win,
      info: {
        disposeOnBuildFinish(disposer: () => Promise<void>) {
          disposers.push(disposer)
        },
      },
    },
  })
}

if (process.env.OPENCODE_TEST_BUILDER_SCENARIO === "packager-error") {
  if (!process.env.OPENCODE_TEST_RESULT_PATH) throw new Error("Builder test result path is required")
  for (const dispose of disposers) await dispose()
  await Bun.write(
    process.env.OPENCODE_TEST_RESULT_PATH,
    JSON.stringify({
      stagedPath: certificateOpaque && stagedLink ? stagedLink : "",
      cleanupRegistered: disposers.length === 1,
      cleanupComplete: stagedLink ? !(await Bun.file(stagedLink).exists()) : false,
    }),
  )
  throw new Error("Simulated packager failure")
}

for (const dispose of disposers) await dispose()

const extraResources = Array.isArray(config.extraResources)
  ? config.extraResources.map((resource: string | { from?: string; to?: string }) =>
      typeof resource === "string" ? resource : { from: resource.from, to: resource.to },
    )
  : []

process.stdout.write(
  `${resultPrefix}${JSON.stringify({
    appId: config.appId,
    productName: config.productName,
    artifactName: config.artifactName,
    protocols: config.protocols,
    publish: config.publish,
    winTarget: config.win?.target,
    ordinarySignFunction: typeof config.win?.signtoolOptions?.sign === "function",
    standardCSC: config.win?.signtoolOptions === undefined,
    forceCodeSigning: config.win?.forceCodeSigning,
    effectiveCscPinned: config.cscLink === stagedLink && config.win?.cscLink === stagedLink,
    nsis: config.nsis,
    extraResources,
    desktopName: config.extraMetadata?.desktopName,
    linuxExecutableName: config.linux?.executableName,
    startupWMClass: config.linux?.desktop?.entry?.StartupWMClass,
    debFpm: config.deb?.fpm,
    rpmFpm: config.rpm?.fpm,
    certificateStaged,
    certificateExists,
    certificateRestricted,
    certificateOpaque,
    cleanupRegistered: disposers.length === 1,
    cleanupComplete:
      !certificateStaged ||
      !stagedLink ||
      (!(await Bun.file(stagedLink).exists()) &&
        process.env.CSC_LINK === undefined &&
        process.env.CSC_KEY_PASSWORD === undefined),
    serializedHidesOriginal,
    serializedHidesPassword,
  })}`,
)
