import path from "node:path"

import type { EnterpriseBuildMetadata } from "./enterprise-build"
import { enterpriseModelCatalogIdentity, validEnterpriseModelDefault } from "../src/main/enterprise-preflight"

export type EnterpriseReleaseInput = {
  archive: string
  version: string
  gitCommit: string
  builtAt: Date
  profile: EnterpriseBuildMetadata
  sbom: string
  licenses: string
  authenticode: "NotSigned"
}

export type EnterpriseWindowsAcceptance = {
  windowsVersion: string
  windowsBuild: string
  testedAt: string
  tester: string
  result: "pass"
}

export type EnterpriseReleaseMetadataV3 = {
  schemaVersion: 3
  appVersion: string
  gitCommit: string
  artifact: string
  sha256: string
  defaultsVersion: string
  guideVersion: string
  defaultModelID: string
  modelIDs: string[]
  modelCatalogSHA256: string
  target: { os: "win32"; arch: "x64" }
  builtAt: string
  authenticode: "NotSigned"
  windowsAcceptance: EnterpriseWindowsAcceptance[]
  sbom: { file: string; sha256: string }
  thirdPartyLicenses: { file: string; sha256: string }
}

export async function writeEnterpriseRelease(input: EnterpriseReleaseInput): Promise<EnterpriseReleaseMetadataV3> {
  const models = enterpriseModelCatalogIdentity(input.profile.models)
  if (!validEnterpriseModelDefault(models.modelIDs, input.profile.defaultModelID)) {
    throw new Error("Enterprise release model catalog is invalid")
  }
  const sha256 = await hash(input.archive)
  const artifact = path.basename(input.archive)
  const metadata = {
    schemaVersion: 3,
    appVersion: input.version,
    gitCommit: input.gitCommit,
    artifact,
    sha256,
    defaultsVersion: input.profile.defaultsVersion,
    guideVersion: input.profile.guideVersion,
    defaultModelID: input.profile.defaultModelID,
    modelCatalogSHA256: models.sha256,
    modelIDs: models.modelIDs,
    target: { os: "win32", arch: "x64" },
    builtAt: input.builtAt.toISOString(),
    authenticode: input.authenticode,
    windowsAcceptance: [],
    sbom: { file: path.basename(input.sbom), sha256: await hash(input.sbom) },
    thirdPartyLicenses: { file: path.basename(input.licenses), sha256: await hash(input.licenses) },
  } satisfies EnterpriseReleaseMetadataV3
  await Bun.write(`${input.archive}.sha256`, `${sha256}  ${artifact}\n`)
  await Bun.write(input.archive.replace(/\.zip$/, ".release.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

async function hash(file: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}
