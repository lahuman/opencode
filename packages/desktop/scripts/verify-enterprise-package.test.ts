import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter, type ZipWriterAddDataOptions } from "@zip.js/zip.js"

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
  const outside = await temporaryDirectory("enterprise-portable-outside-")
  const executable = path.join(root, "Company OpenCode Pilot.exe")
  const target = path.join(outside, "Company OpenCode Pilot.exe")
  await Bun.write(target, "portable executable")
  await rm(executable)
  await symlink(target, executable, "file")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package is missing required files")
})

test("rejects a required payload reached through an external resources link", async () => {
  const root = await portableFixture()
  const outside = await temporaryDirectory("enterprise-portable-outside-")
  const resources = path.join(root, "resources")
  const externalResources = path.join(outside, "resources")
  await rename(resources, externalResources)
  await symlink(externalResources, resources, process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package is missing required files")
})

test("rejects a package root reached through a linked dist ancestor", async () => {
  const project = await temporaryDirectory("enterprise-portable-project-")
  const externalDist = await temporaryDirectory("enterprise-portable-dist-")
  await writePortableFixture(path.join(externalDist, "win-unpacked"))
  await symlink(externalDist, path.join(project, "dist"), process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterprisePackage(path.join(project, "dist/win-unpacked"))).rejects.toThrow(
    "Portable package is missing required files",
  )
})

test("rejects a package root reached through a linked grandparent", async () => {
  const container = await temporaryDirectory("enterprise-portable-container-")
  const external = await temporaryDirectory("enterprise-portable-external-")
  await writePortableFixture(path.join(external, "project/dist/win-unpacked"))
  await symlink(external, path.join(container, "workspace"), process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterprisePackage(path.join(container, "workspace/project/dist/win-unpacked"))).rejects.toThrow(
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

test.each([
  "resources/.. /app.asar",
  "resources/. /app.asar",
  "Setup.EXE.",
  "resources//app.asar",
  "resources/./app.asar",
  "resources/name<.txt",
  "resources/name>.txt",
  "resources/name:.txt",
  'resources/name".txt',
  "resources/name|.txt",
  "resources/name?.txt",
  "resources/name*.txt",
  "resources/name\u0001.txt",
  "resources/name\u007f.txt",
  "CON",
  "resources/PRN.txt",
  "AUX.log",
  "resources/NUL.data",
  "COM1.txt",
  "resources/LPT9.log",
  "resources/COM\u00b9.txt",
  "\\\\.\\PhysicalDrive0",
])("rejects unsafe Windows archive component %s", async (entry) => {
  const archive = await archiveFixture([...required, entry])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test.each(["CONIN$.txt", "resources/conout$.log", "CONIN$."])(
  "rejects a console-device Windows archive component %s",
  async (entry) => {
    const archive = await archiveFixture([...required, entry])

    await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
  },
)

test("rejects a trailing-space console-device component", async () => {
  const archive = await archiveFixture([...required, "CONOUT$x"])
  await rewriteArchiveEntryName(archive, "CONOUT$x", "CONOUT$ ")

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test.each(["C:", "CON", "Setup.EXE"])("rejects DOS directory metadata on a file name %s", async (entry) => {
  const archive = await archiveFixture(
    [...required, entry],
    {},
    {
      [entry]: { externalFileAttributes: 0x10 },
    },
  )

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects file metadata on a slash-terminated directory name", async () => {
  const archive = await archiveFixture(
    [...required, "resources/"],
    {},
    {
      "resources/": { externalFileAttributes: 0x20 },
    },
  )

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a non-ASCII Windows case-collision component", async () => {
  const archive = await archiveFixture([...required, "reſources/app.asar"])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test.each(["resources/ app.asar", "resources/enterprise/ company-guide.md"])(
  "rejects a leading-space Windows archive component %s",
  async (entry) => {
    const archive = await archiveFixture([...required, entry])

    await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
  },
)

test("rejects archive entries that collide on Windows", async () => {
  const archive = await archiveFixture([...required, "resources/APP.ASAR"])

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains duplicate entries")
})

test("rejects a leading-space Windows collision before canonical matching", async () => {
  const archive = await archiveFixture([...required, "xresources/app.asar"])
  await rewriteArchiveEntryName(archive, "xresources/app.asar", " resources/app.asar")

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a valid Unicode-path extra field that masks a raw drive-prefixed name", async () => {
  const rawAppEntry = "C:../../resourcesx"
  const archive = await archiveFixture(
    required.filter((entry) => entry !== "resources/app.asar").concat(rawAppEntry),
    { [rawAppEntry]: "application archive" },
    {
      [rawAppEntry]: {
        useUnicodeFileNames: false,
        extraField: new Map([[0x7075, unicodePathExtraField(rawAppEntry, "resources/app.asar")]]),
      },
    },
  )
  await rewriteArchiveExtraFieldType(archive, rawAppEntry, 0x75, 0x7075)

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test.each([
  ["Unix symlink", 0o120777],
  ["Unix FIFO", 0o010644],
])("rejects a required archive payload marked as a %s", async (_, mode) => {
  const root = await portableFixture()
  const archive = await archiveFixture(
    required,
    {},
    {
      "resources/app.asar": {
        versionMadeBy: 3 << 8,
        externalFileAttributes: (mode << 16) >>> 0,
      },
    },
  )

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive contains an unsafe entry",
  )
})

test("rejects a Darwin-host symlink payload", async () => {
  const archive = await archiveFixture(
    required,
    {},
    {
      "resources/app.asar": {
        versionMadeBy: 19 << 8,
        externalFileAttributes: (0o120777 << 16) >>> 0,
      },
    },
  )

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("accepts a DOS directory entry", async () => {
  const archive = await archiveFixture(
    [...required, "resources/"],
    {},
    {
      "resources/": { msDosCompatible: true, externalFileAttributes: 0x10 },
    },
  )

  await expect(verifyEnterpriseArchive(archive)).resolves.toEqual(required)
})

test("rejects archive entries that collide on a Windows path component", async () => {
  const archive = await archiveFixture([...required, "RESOURCES/app.asar"])

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
  const root = await temporaryDirectory("enterprise-portable-package-")
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

async function archiveFixture(
  entries: string[],
  contents: Record<string, string> = {},
  options: Record<string, ZipWriterAddDataOptions> = {},
) {
  const root = await temporaryDirectory("enterprise-portable-archive-")
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    await writer.add(
      entry,
      entry.endsWith("/")
        ? undefined
        : new TextReader(contents[entry] ?? portableContents[entry] ?? "portable content"),
      { msDosCompatible: true, ...options[entry] },
    )
  }
  const archive = path.join(root, "company-opencode-pilot-1.17.18-win-x64.zip")
  await Bun.write(archive, await writer.close())
  return archive
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), prefix))
  roots.push(root)
  return root
}

async function rewriteArchiveEntryName(archive: string, source: string, target: string) {
  const sourceBytes = new TextEncoder().encode(source)
  const targetBytes = new TextEncoder().encode(target)
  if (sourceBytes.byteLength !== targetBytes.byteLength)
    throw new Error("Archive entry names must have the same length")
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  for (let index = 0; index <= bytes.byteLength - sourceBytes.byteLength; index++) {
    if (sourceBytes.every((byte, offset) => bytes[index + offset] === byte)) bytes.set(targetBytes, index)
  }
  await Bun.write(archive, bytes)
}

function unicodePathExtraField(rawName: string, filename: string) {
  const raw = new TextEncoder().encode(rawName)
  const name = new TextEncoder().encode(filename)
  const data = new Uint8Array(5 + name.byteLength)
  data[0] = 1
  new DataView(data.buffer).setUint32(1, crc32(raw), true)
  data.set(name, 5)
  return data
}

function crc32(input: Uint8Array) {
  let value = 0xffffffff
  for (const byte of input) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

async function rewriteArchiveExtraFieldType(archive: string, name: string, source: number, target: number) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const view = new DataView(bytes.buffer)
  const rawName = new TextEncoder().encode(name)
  for (let offset = 0; offset <= bytes.byteLength - 46; offset++) {
    const signature = view.getUint32(offset, true)
    const central = signature === 0x02014b50
    const local = signature === 0x04034b50
    if (!central && !local) continue
    const nameOffset = offset + (central ? 46 : 30)
    const nameLength = view.getUint16(offset + (central ? 28 : 26), true)
    const extraLength = view.getUint16(offset + (central ? 30 : 28), true)
    if (!rawName.every((byte, index) => bytes[nameOffset + index] === byte) || nameLength !== rawName.byteLength)
      continue
    for (let extra = nameOffset + nameLength; extra < nameOffset + nameLength + extraLength; ) {
      const length = view.getUint16(extra + 2, true)
      if (view.getUint16(extra, true) === source) view.setUint16(extra, target, true)
      extra += 4 + length
    }
  }
  await Bun.write(archive, bytes)
}

const portableContents: Record<string, string> = {
  "Company OpenCode Pilot.exe": "portable executable",
  "resources/app.asar": "application archive",
  "resources/enterprise/opencode.jsonc": JSON.stringify({ enabled_providers: ["company-llm"] }),
  "resources/enterprise/company-guide.md": "# Company guide\n",
  "resources/enterprise/models.json": JSON.stringify({ providers: [] }),
  "resources/licenses/OpenCode-LICENSE": "MIT License\n",
}
