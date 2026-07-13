import { $ } from "bun"
import { fileURLToPath } from "node:url"

import { enterpriseModelEnvironment } from "./enterprise-model-catalog"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

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
