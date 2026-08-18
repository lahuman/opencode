import { createWriteStream } from "node:fs"
import { readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Writable } from "node:stream"
import { BlobReader, ZipWriter } from "@zip.js/zip.js"

import { enterprisePackageEnvironment, validateEnterpriseBuild, type EnterpriseBuildMetadata } from "./enterprise-build"
import { writeEnterpriseRelease, type EnterpriseReleaseInput } from "./enterprise-release"
import { writeEnterpriseSupplyChain } from "./enterprise-supply-chain"
import { verifyEnterpriseArchive, verifyEnterprisePackage } from "./verify-enterprise-package"

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

type EnterprisePackageInput = {
  platform: string
  arch: string
  env: Env
  spawn: Spawn
  version?: string
  validate?: (env: Env) => EnterpriseBuildMetadata
  verifyPackage?: (root: string) => Promise<unknown>
  writeArchive?: typeof writeEnterpriseArchive
  verifyArchive?: (archive: string, root?: string) => Promise<unknown>
  gitCommit?: () => Promise<string>
  release?: (input: EnterpriseReleaseInput) => Promise<unknown>
  supplyChain?: typeof writeEnterpriseSupplyChain
  verifySource?: (cwd: string, env: Env) => Promise<string>
  authenticode?: (executable: string, env: Env) => Promise<"NotSigned">
}

export async function runEnterpriseWindowsPackage(input: EnterprisePackageInput) {
  if (input.platform !== "win32" || input.arch !== "x64") {
    throw new Error("Enterprise portable packaging requires Windows x64")
  }

  const profile = (input.validate ?? validateEnterpriseBuild)(input.env)
  const env = enterprisePackageEnvironment(input.env)
  const options = {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "inherit" as const,
    stderr: "inherit" as const,
  }
  const reviewedCommit = await input.verifySource?.(options.cwd, env)
  const build = await input.spawn([env.BUN ?? "bun", "run", "build"], options).exited
  if (build !== 0) return build
  const packageCode = await input.spawn([env.BUN ?? "bun", "run", "package:win", "--x64", "--dir"], options).exited
  if (packageCode !== 0) return packageCode

  const version =
    input.version ?? (await Bun.file(path.join(options.cwd, "package.json")).json<{ version: string }>()).version
  const archive = path.join(options.cwd, "dist", `sfmi-${version}-win-x64.zip`)
  const root = path.join(options.cwd, "dist", "win-unpacked")
  await (input.verifyPackage ?? verifyEnterprisePackage)(root)
  await (input.writeArchive ?? writeEnterpriseArchive)({ archive, root })
  await (input.verifyArchive ?? verifyEnterpriseArchive)(archive, root)
  const packagedCommit = await input.verifySource?.(options.cwd, env)
  if (reviewedCommit && packagedCommit !== reviewedCommit) {
    throw new Error("Enterprise package source changed during the build")
  }
  const gitCommit = packagedCommit ?? reviewedCommit ?? (await (input.gitCommit ?? (() => resolveGitCommit(options.cwd, env)))())
  const authenticode = await (input.authenticode?.(path.join(root, "SFMI.exe"), env) ??
    Promise.resolve("NotSigned" as const))
  const builtAt = new Date()
  const supplyChain = await (input.supplyChain ?? writeEnterpriseSupplyChain)({ archive, appVersion: version, builtAt })
  await (input.release ?? writeEnterpriseRelease)({
    archive,
    version,
    gitCommit,
    builtAt,
    profile,
    authenticode,
    ...supplyChain,
  })
  return 0
}

export async function writeEnterpriseArchive(input: { archive: string; root: string }) {
  const temporary = `${input.archive}.tmp`
  await rm(temporary, { force: true })
  const writer = new ZipWriter(Writable.toWeb(createWriteStream(temporary)), {
    extendedTimestamp: false,
    keepOrder: true,
    level: 7,
  })
  await (await enterpriseArchiveEntries(input.root)).reduce(async (previous, entry) => {
    await previous
    await writer.add(entry.name, entry.directory ? undefined : new BlobReader(Bun.file(entry.path)), {
      directory: entry.directory,
      extendedTimestamp: false,
      lastModDate: new Date(1980, 0, 1),
      msDosCompatible: true,
    })
  }, Promise.resolve())
  await writer.close()
  await rename(temporary, input.archive)
}

async function enterpriseArchiveEntries(directory: string, relative = "") {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true }))
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map(async (entry) => {
          const name = relative ? `${relative}/${entry.name}` : entry.name
          const entryPath = path.join(directory, entry.name)
          if (entry.isDirectory()) {
            return [
              { directory: true, name: `${name}/`, path: entryPath },
              ...(await enterpriseArchiveEntries(entryPath, name)),
            ]
          }
          if (entry.isFile()) return [{ directory: false, name, path: entryPath }]
          throw new Error("Enterprise package contains an unsupported filesystem entry")
        }),
    )
  ).flat()
}

async function resolveGitCommit(cwd: string, env: Env) {
  const process = Bun.spawn([env.GIT ?? "git", "rev-parse", "HEAD"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "inherit",
  })
  if ((await process.exited) !== 0) throw new Error("Unable to resolve the enterprise package git commit")
  const commit = (await new Response(process.stdout).text()).trim()
  if (!commit) throw new Error("Unable to resolve the enterprise package git commit")
  return commit
}

export async function verifyEnterpriseSource(cwd: string, env: Env) {
  const status = Bun.spawn([env.GIT ?? "git", "status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "inherit",
  })
  if ((await status.exited) !== 0 || (await new Response(status.stdout).text()).trim()) {
    throw new Error("Enterprise packaging requires a clean reviewed source tree")
  }
  return resolveGitCommit(cwd, env)
}

export async function verifyEnterpriseAuthenticode(executable: string, env: Env) {
  const result = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "$status = (Get-AuthenticodeSignature -LiteralPath $env:OPENCODE_ENTERPRISE_SIGNATURE_PATH).Status.ToString(); [Console]::Out.Write($status)",
    ],
    {
      env: { ...env, OPENCODE_ENTERPRISE_SIGNATURE_PATH: executable },
      stdout: "pipe",
      stderr: "inherit",
    },
  )
  if ((await result.exited) !== 0 || (await new Response(result.stdout).text()).trim() !== "NotSigned") {
    throw new Error("Enterprise portable executable must be unsigned")
  }
  return "NotSigned" as const
}

if (import.meta.main) {
  const code = await runEnterpriseWindowsPackage({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    spawn: (command, options) => Bun.spawn(command, options),
    verifySource: verifyEnterpriseSource,
    authenticode: verifyEnterpriseAuthenticode,
  })
  if (code !== 0) process.exit(code)
}
