import path from "node:path"

import type { EnterpriseBuildMetadata } from "./enterprise-build"

export type EnterpriseReleaseInput = {
  archive: string
  version: string
  gitCommit: string
  builtAt: Date
  profile: EnterpriseBuildMetadata
}

export type EnterpriseWindowsAcceptance = {
  windowsVersion: string
  windowsBuild: string
  testedAt: string
  tester: string
  result: "pass"
}

export type EnterpriseReleaseMetadata = {
  schemaVersion: 1
  appVersion: string
  gitCommit: string
  artifact: string
  sha256: string
  defaultsVersion: string
  guideVersion: string
  modelID: string
  target: { os: "win32"; arch: "x64" }
  builtAt: string
  authenticode: "NotSigned"
  windowsAcceptance: EnterpriseWindowsAcceptance[]
}

export async function writeEnterpriseRelease(input: EnterpriseReleaseInput): Promise<EnterpriseReleaseMetadata> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(input.archive).stream()) hasher.update(chunk)
  const sha256 = hasher.digest("hex")
  const artifact = path.basename(input.archive)
  const metadata = {
    schemaVersion: 1,
    appVersion: input.version,
    gitCommit: input.gitCommit,
    artifact,
    sha256,
    defaultsVersion: input.profile.defaultsVersion,
    guideVersion: input.profile.guideVersion,
    modelID: input.profile.modelID,
    target: { os: "win32", arch: "x64" },
    builtAt: input.builtAt.toISOString(),
    authenticode: "NotSigned",
    windowsAcceptance: [],
  } satisfies EnterpriseReleaseMetadata
  await Bun.write(`${input.archive}.sha256`, `${sha256}  ${artifact}\n`)
  await Bun.write(input.archive.replace(/\.zip$/, ".release.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}
