import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeEnterpriseSupplyChain } from "./enterprise-supply-chain"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("writes deterministic CycloneDX and third-party license artifacts from the locked dependency set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-supply-chain-"))
  roots.push(root)
  const archive = path.join(root, "sfmi-1.0.0-win-x64.zip")
  const modules = path.join(root, "node_modules")
  await mkdir(path.join(modules, "alpha"), { recursive: true })
  await mkdir(path.join(root, "ripgrep"), { recursive: true })
  await Bun.write(archive, "zip")
  await Bun.write(
    path.join(root, "bun.lock"),
    `{
      "packages": {
        "alpha": ["alpha@1.2.3", "", {}],
        "beta": ["beta@2.0.0", "", {}],
      },
    }`,
  )
  await Bun.write(path.join(modules, "alpha", "package.json"), JSON.stringify({ name: "alpha", version: "1.2.3", license: "MIT" }))
  await Bun.write(path.join(modules, "alpha", "LICENSE"), "Alpha license text")
  await Bun.write(path.join(root, "ripgrep", "LICENSE-MIT"), "Ripgrep MIT license text")
  await Bun.write(path.join(root, "ripgrep", "UNLICENSE"), "Ripgrep Unlicense text")

  const result = await writeEnterpriseSupplyChain({
    archive,
    lockfile: path.join(root, "bun.lock"),
    nodeModules: modules,
    appVersion: "1.0.0",
    builtAt: new Date("2026-07-16T00:00:00.000Z"),
    ripgrepDir: path.join(root, "ripgrep"),
  })

  const sbom = await Bun.file(result.sbom).json()
  expect(sbom).toMatchObject({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { timestamp: "2026-07-16T00:00:00.000Z", component: { name: "sfmi", version: "1.0.0" } },
  })
  expect(sbom.components.map((component: { name: string; version: string }) => [component.name, component.version])).toEqual([
    ["alpha", "1.2.3"],
    ["beta", "2.0.0"],
    ["ripgrep", "15.1.0"],
  ])
  expect(sbom.components[2]).toMatchObject({
    licenses: [{ expression: "MIT OR Unlicense" }],
    externalReferences: [
      {
        type: "distribution",
        url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
      },
    ],
  })
  const licenses = await Bun.file(result.licenses).text()
  expect(licenses).toStartWith("CHAI third-party licenses\n")
  expect(licenses).toContain("alpha@1.2.3\nDeclared license: MIT\nAlpha license text")
  expect(licenses).toContain("beta@2.0.0\nDeclared license: NOASSERTION")
  expect(licenses).toContain("ripgrep@15.1.0\nOfficial source: https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/")
  expect(licenses).toContain("Ripgrep MIT license text\n\nRipgrep Unlicense text")
})
