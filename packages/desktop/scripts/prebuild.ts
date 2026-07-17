#!/usr/bin/env bun
import { $ } from "bun"
import { fileURLToPath } from "node:url"

import { enterpriseModelEnvironment } from "./enterprise-model-catalog"
import { prepareEnterpriseManifest } from "./enterprise-manifest"
import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await prepareEnterpriseManifest({
  appVersion: (await Bun.file(new URL("../package.json", import.meta.url)).json<{ version: string }>()).version,
  env: process.env,
  output: fileURLToPath(new URL("../resources/enterprise/enterprise-manifest.json", import.meta.url)),
  resources: {
    "opencode.jsonc": fileURLToPath(new URL("../resources/enterprise/opencode.jsonc", import.meta.url)),
    "company-guide.md": fileURLToPath(new URL("../resources/enterprise/company-guide.md", import.meta.url)),
    "models.json": fileURLToPath(new URL("../resources/enterprise/models.json", import.meta.url)),
    "skill-packs.json": fileURLToPath(new URL("../resources/enterprise/skill-packs.json", import.meta.url)),
  },
})

const child = Bun.spawn([process.env.BUN ?? "bun", "script/build-node.ts"], {
  cwd: fileURLToPath(new URL("../../opencode/", import.meta.url)),
  env: enterpriseModelEnvironment(
    process.env,
    fileURLToPath(new URL("../resources/enterprise/models.json", import.meta.url)),
  ),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
if ((await child.exited) !== 0) throw new Error("OpenCode node build failed")
