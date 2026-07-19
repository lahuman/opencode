import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { validateEnterpriseBuild } from "./enterprise-build"
import { type EnterpriseWindowsAcceptance, writeEnterpriseRelease } from "./enterprise-release"

const roots: string[] = []
const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
    { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
    { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
  ]),
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
}

const acceptance = {
  windowsVersion: "Windows 11 Enterprise",
  windowsBuild: "10.0.26100.1",
  testedAt: "2026-07-15T00:00:00.000Z",
  tester: "pilot-tester",
  result: "pass",
} satisfies EnterpriseWindowsAcceptance

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("writes checksum and non-secret release metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-release-"))
  roots.push(root)
  const archive = path.join(root, "kernexa-1.17.18-win-x64.zip")
  await Bun.write(archive, "portable archive")
  const sbom = archive.replace(/\.zip$/, ".sbom.cdx.json")
  const licenses = archive.replace(/\.zip$/, ".third-party-licenses.txt")
  await Bun.write(sbom, "sbom")
  await Bun.write(licenses, "licenses")

  const result = await writeEnterpriseRelease({
    archive,
    version: "1.17.18",
    gitCommit: "0123456789abcdef",
    builtAt: new Date("2026-07-15T00:00:00.000Z"),
    profile: validateEnterpriseBuild(valid),
    sbom,
    licenses,
    authenticode: "NotSigned",
  })

  expect(result).toMatchObject({
    schemaVersion: 3,
    artifact: "kernexa-1.17.18-win-x64.zip",
    appVersion: "1.17.18",
    gitCommit: "0123456789abcdef",
    target: { os: "win32", arch: "x64" },
    authenticode: "NotSigned",
    defaultModelID: "company-code",
    modelIDs: ["company-code", "company-fast"],
    modelCatalogSHA256: expect.stringMatching(/^[a-f0-9]{64}$/),
    windowsAcceptance: [],
    sbom: { file: "kernexa-1.17.18-win-x64.sbom.cdx.json", sha256: expect.any(String) },
    thirdPartyLicenses: {
      file: "kernexa-1.17.18-win-x64.third-party-licenses.txt",
      sha256: expect.any(String),
    },
  })
  expect(result.sha256).toBe("d0290b9062401137b81620928d54bc40e808f35a7f2fc550d2821d01c95488f5")
  expect(await Bun.file(`${archive}.sha256`).text()).toBe(`${result.sha256}  ${result.artifact}\n`)

  const metadata = await Bun.file(archive.replace(/\.zip$/, ".release.json")).text()
  expect(JSON.parse(metadata)).toEqual(result)
  expect(result.windowsAcceptance).toEqual([])
  expect(Object.keys(acceptance)).toEqual(["windowsVersion", "windowsBuild", "testedAt", "tester", "result"])
  for (const value of ["https://llm.corp.example", "credential-secret", "Authorization", "CSC_LINK"]) {
    expect(metadata).not.toContain(value)
  }
})

test("declares structured Windows acceptance records", async () => {
  const source = await Bun.file(new URL("./enterprise-release.ts", import.meta.url)).text()

  expect(source).toContain("export type EnterpriseWindowsAcceptance")
  expect(source).toContain("windowsAcceptance: EnterpriseWindowsAcceptance[]")
})
