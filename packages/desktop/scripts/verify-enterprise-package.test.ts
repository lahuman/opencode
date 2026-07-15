import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"

import { verifyEnterpriseArchive, verifyEnterprisePackage } from "./verify-enterprise-package"

const roots: string[] = []
const required = [
  "Company OpenCode Pilot.exe",
  "resources/app.asar",
  "resources/enterprise/opencode.jsonc",
  "resources/enterprise/company-guide.md",
  "resources/enterprise/models.json",
  "resources/licenses/OpenCode-LICENSE",
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("accepts a complete portable enterprise tree", async () => {
  const root = await portableFixture()

  await expect(verifyEnterprisePackage(root)).resolves.toEqual({
    executable: "Company OpenCode Pilot.exe",
    defaults: true,
    guide: true,
    models: true,
    appArchive: true,
    license: true,
  })
})

test.each(required)("rejects a package missing %s", async (relative) => {
  const root = await portableFixture()
  await rm(path.join(root, relative), { force: true })

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package")
})

test.each(required)("rejects a package directory at %s", async (relative) => {
  const root = await portableFixture()
  const file = path.join(root, relative)
  await rm(file, { force: true })
  await mkdir(file)

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package is missing required files")
})

test("rejects a required payload symlinked outside the package root", async () => {
  const root = await portableFixture()
  const outside = await mkdtemp(path.join(tmpdir(), "enterprise-portable-outside-"))
  roots.push(outside)
  const executable = path.join(root, "Company OpenCode Pilot.exe")
  const target = path.join(outside, "Company OpenCode Pilot.exe")
  await Bun.write(target, "portable executable")
  await rm(executable)
  await symlink(target, executable, "file")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package is missing required files")
})

test("rejects a required payload reached through an external resources link", async () => {
  const root = await portableFixture()
  const outside = await mkdtemp(path.join(tmpdir(), "enterprise-portable-outside-"))
  roots.push(outside)
  const resources = path.join(root, "resources")
  const externalResources = path.join(outside, "resources")
  await rename(resources, externalResources)
  await symlink(externalResources, resources, process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package is missing required files")
})

test("rejects a package root reached through a linked dist ancestor", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "enterprise-portable-project-"))
  const externalDist = await mkdtemp(path.join(tmpdir(), "enterprise-portable-dist-"))
  roots.push(project, externalDist)
  await writePortableFixture(path.join(externalDist, "win-unpacked"))
  await symlink(externalDist, path.join(project, "dist"), process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterprisePackage(path.join(project, "dist/win-unpacked"))).rejects.toThrow(
    "Portable package is missing required files",
  )
})

test("rejects defaults without the company provider", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/enterprise/opencode.jsonc"), JSON.stringify({ enabled_providers: [] }))

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package defaults")
})

test("rejects an empty guide", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/enterprise/company-guide.md"), "")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package guide")
})

test("rejects invalid models JSON", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/enterprise/models.json"), "not json")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package catalog")
})

test("rejects an empty app archive", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/app.asar"), "")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package archive")
})

test("rejects a missing OpenCode license notice", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/licenses/OpenCode-LICENSE"), "Proprietary")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package license")
})

test("accepts an archive with the required portable entries", async () => {
  const root = await portableFixture()
  const archive = await archiveFixture(required)

  await expect(verifyEnterpriseArchive(archive, root)).resolves.toEqual(required)
})

test.each([
  "resources\\app.asar",
  "resources/../Company OpenCode Pilot.exe",
  "/Company OpenCode Pilot.exe",
  "C:..\\outside",
  "C:../outside",
  "C:/outside",
  "\\\\server\\share\\outside",
  "\\\\?\\C:\\outside",
  "Company OpenCode Pilot Setup.exe",
  "Uninstall Company OpenCode Pilot.exe",
  "Setup.EXE",
])("rejects unsafe archive entry %s", async (entry) => {
  const archive = await archiveFixture([...required, entry])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive")
})

test("rejects archive entries that collide on Windows", async () => {
  const archive = await archiveFixture([...required, "resources/APP.ASAR"])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains duplicate entries")
})

test("rejects an archive missing a required portable entry", async () => {
  const archive = await archiveFixture(required.filter((entry) => entry !== "resources/app.asar"))

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive")
})

test("rejects a traversal directory entry", async () => {
  const archive = await archiveFixture([...required, "../outside/"])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive")
})

test("rejects archive defaults without the company provider", async () => {
  const archive = await archiveFixture(required, { "resources/enterprise/opencode.jsonc": JSON.stringify({}) })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package defaults")
})

test("rejects an archive with an empty app archive", async () => {
  const archive = await archiveFixture(required, { "resources/app.asar": "" })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive")
})

test("rejects an archive without the OpenCode license notice", async () => {
  const archive = await archiveFixture(required, { "resources/licenses/OpenCode-LICENSE": "Proprietary" })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package license")
})

test("rejects required archive contents that differ from the verified unpacked package", async () => {
  const root = await portableFixture()
  const archive = await archiveFixture(required, { "resources/licenses/OpenCode-LICENSE": "MIT License\nChanged\n" })

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow("Portable package archive does not match")
})

async function portableFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-portable-package-"))
  roots.push(root)
  await writePortableFixture(root)
  return root
}

async function writePortableFixture(root: string) {
  await Promise.all([
    mkdir(path.join(root, "resources/enterprise"), { recursive: true }),
    mkdir(path.join(root, "resources/licenses"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(root, "Company OpenCode Pilot.exe"), "portable executable"),
    Bun.write(path.join(root, "resources/app.asar"), "application archive"),
    Bun.write(
      path.join(root, "resources/enterprise/opencode.jsonc"),
      JSON.stringify({ enabled_providers: ["company-llm"] }),
    ),
    Bun.write(path.join(root, "resources/enterprise/company-guide.md"), "# Company guide\n"),
    Bun.write(path.join(root, "resources/enterprise/models.json"), JSON.stringify({ providers: [] })),
    Bun.write(path.join(root, "resources/licenses/OpenCode-LICENSE"), "MIT License\n"),
  ])
}

async function archiveFixture(entries: string[], contents: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-portable-archive-"))
  roots.push(root)
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    await writer.add(
      entry,
      entry.endsWith("/")
        ? undefined
        : new TextReader(contents[entry] ?? portableContents[entry] ?? "portable content"),
    )
  }
  const archive = path.join(root, "company-opencode-pilot-1.17.18-win-x64.zip")
  await Bun.write(archive, await writer.close())
  return archive
}

const portableContents: Record<string, string> = {
  "Company OpenCode Pilot.exe": "portable executable",
  "resources/app.asar": "application archive",
  "resources/enterprise/opencode.jsonc": JSON.stringify({ enabled_providers: ["company-llm"] }),
  "resources/enterprise/company-guide.md": "# Company guide\n",
  "resources/enterprise/models.json": JSON.stringify({ providers: [] }),
  "resources/licenses/OpenCode-LICENSE": "MIT License\n",
}
