import path from "node:path"

import { validateEnterpriseBuild } from "./enterprise-build"
import { generateEnterpriseManifest } from "./enterprise-manifest"

type Env = Record<string, string | undefined>
type Spawn = (
  command: string[],
  options: {
    cwd: string
    env: Env
    stdin: "inherit"
    stdout: "inherit"
    stderr: "inherit"
  },
) => { exited: Promise<number> }
type Prepare = (input: Parameters<typeof generateEnterpriseManifest>[0]) => Promise<unknown>

export async function runEnterpriseDev(input: { env: Env; spawn: Spawn; prepare?: Prepare }) {
  const env = { ...input.env, OPENCODE_ENTERPRISE: "1" }
  validateEnterpriseBuild(env)
  const root = path.resolve(import.meta.dir, "..")
  await (input.prepare ?? generateEnterpriseManifest)({
    appVersion: (await Bun.file(path.join(root, "package.json")).json<{ version: string }>()).version,
    env,
    output: path.join(root, "resources", "enterprise", "enterprise-manifest.json"),
    resources: {
      "opencode.jsonc": path.join(root, "resources", "enterprise", "opencode.jsonc"),
      "company-guide.md": path.join(root, "resources", "enterprise", "company-guide.md"),
      "models.json": path.join(root, "resources", "enterprise", "models.json"),
      "skill-packs.json": path.join(root, "resources", "enterprise", "skill-packs.json"),
    },
  })
  return input.spawn(["bun", "run", "dev"], {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited
}

if (import.meta.main) {
  const code = await runEnterpriseDev({
    env: process.env,
    spawn: (command, options) => Bun.spawn(command, options),
  })
  if (code !== 0) process.exit(code)
}
