import path from "node:path"

import { enterprisePackageEnvironment, validateEnterpriseBuild } from "./enterprise-build"

type Env = Record<string, string | undefined>
type Spawn = (
  command: string[],
  options: {
    cwd: string
    env: Env
    stdout: "inherit"
    stderr: "inherit"
  },
) => { exited: Promise<number> }

export async function runEnterpriseWindowsPackage(input: { platform: string; arch: string; env: Env; spawn: Spawn }) {
  if (input.platform !== "win32" || input.arch !== "x64") {
    throw new Error("Enterprise portable packaging requires Windows x64")
  }

  validateEnterpriseBuild(input.env)
  const env = enterprisePackageEnvironment(input.env)
  const options = {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "inherit" as const,
    stderr: "inherit" as const,
  }
  const build = await input.spawn(["bun", "run", "build"], options).exited
  if (build !== 0) return build
  return input.spawn(["bun", "run", "package:win", "--x64"], options).exited
}

if (import.meta.main) {
  const code = await runEnterpriseWindowsPackage({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    spawn: (command, options) => Bun.spawn(command, options),
  })
  if (code !== 0) process.exit(code)
}
