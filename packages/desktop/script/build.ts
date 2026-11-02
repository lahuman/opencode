#!/usr/bin/env bun
import { $ } from "bun"
import { exists } from "node:fs/promises"
import path from "node:path"
import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"
import { verifyBundles } from "./verify-bundles"
import { enterpriseModelEnvironment } from "./enterprise-model-catalog"
import { prepareEnterpriseManifest } from "./enterprise-manifest"
import { prepareEnterpriseRipgrep } from "./prepare-enterprise-ripgrep"

// Prepares resources/ (icons, metainfo, the bundled CLI) for OPENCODE_CHANNEL and builds the app into out/.
// The CLI comes from ../cli/dist when it holds the target; otherwise dev downloads the published dev CLI,
// beta the beta CLI, and prod fails.
const dir = path.resolve(import.meta.dir, "..")

const cli = path.resolve(dir, "../cli/dist")

const channel = resolveChannel()

process.chdir(dir)

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

if (process.env.OPENCODE_ENTERPRISE === "1") {
  const resources = path.join(dir, "resources", "enterprise")
  await prepareEnterpriseRipgrep({ env: process.env, output: path.join(resources, "ripgrep") })
  await prepareEnterpriseManifest({
    appVersion: (await Bun.file(path.join(dir, "package.json")).json<{ version: string }>()).version,
    env: process.env,
    output: path.join(resources, "enterprise-manifest.json"),
    resources: {
      "opencode.jsonc": path.join(resources, "opencode.jsonc"),
      "company-guide.md": path.join(resources, "company-guide.md"),
      "models.json": path.join(resources, "models.json"),
      "skill-packs.json": path.join(resources, "skill-packs.json"),
      "ripgrep/rg.exe": path.join(resources, "ripgrep", "rg.exe"),
      "ripgrep/LICENSE-MIT": path.join(resources, "ripgrep", "LICENSE-MIT"),
      "ripgrep/UNLICENSE": path.join(resources, "ripgrep", "UNLICENSE"),
    },
  })
  const child = Bun.spawn(
    [process.env.BUN ?? "bun", "script/build.ts", "--skip-install", "--skip-web-ui", "--outdir=.cache/enterprise-cli"],
    {
      cwd: path.resolve(dir, "../cli"),
      env: {
        ...enterpriseModelEnvironment(process.env, path.join(resources, "models.json")),
        OPENCODE_TARGET: getCurrentCli().package.replace("@opencode/cli-", ""),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  if ((await child.exited) !== 0) throw new Error("Enterprise CLI build failed")
  await copyBuiltCliToResources(path.resolve(dir, "../cli/.cache/enterprise-cli"))
}

const built = await exists(path.join(cli, getCurrentCli().package.replace("@opencode/", "")))

if (process.env.OPENCODE_ENTERPRISE !== "1" && channel === "prod" && !built)
  throw new Error(`Production desktop builds bundle the CLI from ${cli}; build it first`)

if (process.env.OPENCODE_ENTERPRISE !== "1" && built) await copyBuiltCliToResources(cli)

if (process.env.OPENCODE_ENTERPRISE !== "1" && !built)
  await downloadCliToResources(channel === "beta" ? "beta" : undefined)

await $`bunx electron-vite build`

await verifyBundles(path.join(dir, "out"))
