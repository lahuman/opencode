#!/usr/bin/env bun
import { $ } from "bun"
import { fileURLToPath } from "node:url"

import { enterpriseModelEnvironment } from "./enterprise-model-catalog"
import { prepareEnterpriseManifest } from "./enterprise-manifest"
import { prepareEnterpriseRipgrep } from "./prepare-enterprise-ripgrep"
import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"

const channel = resolveChannel()

if (process.env.OPENCODE_ENTERPRISE !== "1" && channel === "prod" && !Bun.env.OPENCODE_CLI_DIST) {
  throw new Error("OPENCODE_CLI_DIST is required for production desktop builds")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (process.env.OPENCODE_ENTERPRISE === "1") {
  await prepareEnterpriseRipgrep({
    env: process.env,
    output: fileURLToPath(new URL("../resources/enterprise/ripgrep", import.meta.url)),
  })

  await prepareEnterpriseManifest({
    appVersion: (await Bun.file(new URL("../package.json", import.meta.url)).json<{ version: string }>()).version,
    env: process.env,
    output: fileURLToPath(new URL("../resources/enterprise/enterprise-manifest.json", import.meta.url)),
    resources: {
      "opencode.jsonc": fileURLToPath(new URL("../resources/enterprise/opencode.jsonc", import.meta.url)),
      "company-guide.md": fileURLToPath(new URL("../resources/enterprise/company-guide.md", import.meta.url)),
      "models.json": fileURLToPath(new URL("../resources/enterprise/models.json", import.meta.url)),
      "skill-packs.json": fileURLToPath(new URL("../resources/enterprise/skill-packs.json", import.meta.url)),
      "ripgrep/rg.exe": fileURLToPath(new URL("../resources/enterprise/ripgrep/rg.exe", import.meta.url)),
      "ripgrep/LICENSE-MIT": fileURLToPath(new URL("../resources/enterprise/ripgrep/LICENSE-MIT", import.meta.url)),
      "ripgrep/UNLICENSE": fileURLToPath(new URL("../resources/enterprise/ripgrep/UNLICENSE", import.meta.url)),
    },
  })

  const child = Bun.spawn(
    [
      process.env.BUN ?? "bun",
      "script/build.ts",
      `--target=${getCurrentCli().package.replace("@opencode/cli-", "opencode-")}`,
      "--skip-install",
      "--skip-web-ui",
      "--outdir=.cache/enterprise-cli",
    ],
    {
      cwd: fileURLToPath(new URL("../../cli/", import.meta.url)),
      env: enterpriseModelEnvironment(
        process.env,
        fileURLToPath(new URL("../resources/enterprise/models.json", import.meta.url)),
      ),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  if ((await child.exited) !== 0) throw new Error("Enterprise CLI build failed")
  await copyBuiltCliToResources(fileURLToPath(new URL("../../cli/.cache/enterprise-cli", import.meta.url)))
}
if (process.env.OPENCODE_ENTERPRISE !== "1") {
  if (channel === "dev") await downloadCliToResources()
  if ((channel === "beta" || channel === "prod") && Bun.env.OPENCODE_CLI_DIST)
    await copyBuiltCliToResources(Bun.env.OPENCODE_CLI_DIST)
  if (channel === "beta" && !Bun.env.OPENCODE_CLI_DIST) await downloadCliToResources("beta")
}
