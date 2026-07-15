import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const resultPrefix = "OPENCODE_TEST_RESULT:"
const electronBuilder = require.resolve("electron-builder")
const loaderPath = require.resolve("app-builder-lib/out/util/config/config", {
  paths: [path.dirname(electronBuilder)],
})
const loader = require(loaderPath)
const projectDir = path.resolve(import.meta.dir, "..")
const config = await loader.getConfig(projectDir, "electron-builder.config.ts", null)

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
    nsis: config.nsis,
    cscLink: config.cscLink,
    beforePack: typeof config.beforePack === "function",
    extraResources,
    desktopName: config.extraMetadata?.desktopName,
    linuxExecutableName: config.linux?.executableName,
    startupWMClass: config.linux?.desktop?.entry?.StartupWMClass,
    debFpm: config.deb?.fpm,
    rpmFpm: config.rpm?.fpm,
  })}`,
)
