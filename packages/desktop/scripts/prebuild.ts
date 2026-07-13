#!/usr/bin/env bun
import { $ } from "bun"
import { fileURLToPath } from "node:url"

import { enterpriseModelEnvironment } from "./enterprise-model-catalog"
import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

const child = Bun.spawn(["bun", "script/build-node.ts"], {
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
