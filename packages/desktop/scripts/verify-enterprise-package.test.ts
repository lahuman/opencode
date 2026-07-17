import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter, type ZipWriterAddDataOptions } from "@zip.js/zip.js"

import { verifyEnterpriseArchive, verifyEnterprisePackage } from "./verify-enterprise-package"
import { enterpriseModelCatalogIdentity } from "../src/main/enterprise-preflight"
import { writeEnterpriseArchive } from "./package-enterprise-win"

const roots: string[] = []
const required = [
  "Company OpenCode Pilot.exe",
  "resources/app.asar",
  "resources/enterprise/opencode.jsonc",
  "resources/enterprise/company-guide.md",
  "resources/enterprise/models.json",
  "resources/enterprise/enterprise-manifest.json",
  "resources/enterprise/skill-packs.json",
  "resources/enterprise/skill-packs/ponytail/LICENSE",
  "resources/enterprise/skill-packs/ponytail/skills/ponytail/SKILL.md",
  "resources/enterprise/skill-packs/caveman/LICENSE",
  "resources/enterprise/skill-packs/caveman/skills/caveman/SKILL.md",
  "resources/enterprise/skill-packs/superpowers/LICENSE",
  "resources/enterprise/skill-packs/superpowers/skills/using-superpowers/SKILL.md",
  "resources/licenses/OpenCode-LICENSE",
]
const enterpriseGuide = await Bun.file(new URL("../resources/enterprise/company-guide.md", import.meta.url)).text()
const enterpriseDefaults = JSON.stringify({ enabled_providers: ["company-llm"] })
const enterpriseModels = JSON.stringify({ providers: [] })
const enterpriseModelCatalog = [
  { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
]
const packLicense = "MIT License\n"
const packSkills = {
  ponytail: "---\nname: ponytail\ndescription: Test.\n---\n\n# Ponytail\n",
  caveman: "---\nname: caveman\ndescription: Test.\n---\n\n# Caveman\n",
  superpowers: "---\nname: using-superpowers\ndescription: Test.\n---\n\n# Superpowers\n",
}
const enterpriseSkillPacks = `${JSON.stringify(
  {
    schemaVersion: 1,
    packs: [
      testPack("ponytail", "Ponytail", "4.8.4", true, "ponytail"),
      testPack("caveman", "Caveman", "v1.9.1", false, "caveman"),
      testPack("superpowers", "Superpowers", "v6.1.1", true, "using-superpowers"),
    ],
  },
  null,
  2,
)}\n`

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
    manifest: true,
    appArchive: true,
    license: true,
    skillPacks: true,
  })
})

test("writes a timestamp-free archive accepted by the portable verifier", async () => {
  const root = await portableFixture()
  const output = await temporaryDirectory("enterprise-portable-output-")
  const archive = path.join(output, "company-opencode-pilot-1.17.18-win-x64.zip")

  await writeEnterpriseArchive({ archive, root })

  await expect(verifyEnterpriseArchive(archive, root)).resolves.toEqual(expect.arrayContaining(required))
})

test.each(required)("rejects a package missing %s", async (relative) => {
  const root = await portableFixture()
  await rm(path.join(root, relative), { force: true })

  await expect(verifyEnterprisePackage(root)).rejects.toThrow(/Portable package|Enterprise skill pack/)
})

test.each(required)("rejects a package directory at %s", async (relative) => {
  const root = await portableFixture()
  const file = path.join(root, relative)
  await rm(file, { force: true })
  await mkdir(file)

  await expect(verifyEnterprisePackage(root)).rejects.toThrow(/Portable package is missing required files|Enterprise skill pack/)
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

test("rejects an extra payload symlink in the unpacked tree", async () => {
  const root = await portableFixture()
  const outside = await temporaryDirectory("enterprise-portable-outside-")
  const target = path.join(outside, "extra.dll")
  await Bun.write(target, "outside payload")
  await symlink(target, path.join(root, "resources/extra.dll"), "file")

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

test("rejects a guide with another H1", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/enterprise/company-guide.md"), "# Different company guide\n")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package guide")
})

test("rejects invalid models JSON", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/enterprise/models.json"), "not json")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package catalog")
})

test("rejects enterprise resources changed after manifest creation", async () => {
  const root = await portableFixture()
  await Bun.write(
    path.join(root, "resources/enterprise/opencode.jsonc"),
    JSON.stringify({ enabled_providers: ["company-llm"], theme: "company" }),
  )

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package enterprise manifest")
})

test("rejects an empty app archive", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "resources/app.asar"), "")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package archive")
})

test("rejects an empty portable executable", async () => {
  const root = await portableFixture()
  await Bun.write(path.join(root, "Company OpenCode Pilot.exe"), "")

  await expect(verifyEnterprisePackage(root)).rejects.toThrow("Portable package executable")
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

test("rejects an archive-only regular file", async () => {
  const root = await portableFixture()
  const archive = await archiveFixture([...required, "resources/extra.dll"])

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive does not match the verified unpacked package",
  )
})

test("rejects an unpacked-only regular file", async () => {
  const root = await portableFixture()
  await writePortableFile(root, "resources/extra.dll", "unpacked payload")
  const archive = await archiveFixture(required)

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive does not match the verified unpacked package",
  )
})

test("rejects an extra regular file whose bytes differ", async () => {
  const root = await portableFixture()
  await writePortableFile(root, "resources/extra.dll", "unpacked payload")
  const archive = await archiveFixture([...required, "resources/extra.dll"], {
    "resources/extra.dll": "archive payload",
  })

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive does not match the verified unpacked package",
  )
})

test("accepts an explicit archive entry for an unpacked empty directory", async () => {
  const root = await portableFixture()
  await mkdir(path.join(root, "resources/empty"))
  const archive = await archiveFixture([...required, "resources/empty/"])

  await expect(verifyEnterpriseArchive(archive, root)).resolves.toEqual(required)
})

test("rejects an unpacked empty directory omitted by the archive", async () => {
  const root = await portableFixture()
  await mkdir(path.join(root, "resources/empty"))
  const archive = await archiveFixture(required)

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive does not match the verified unpacked package",
  )
})

test("rejects an explicit archive empty directory absent from the unpacked tree", async () => {
  const root = await portableFixture()
  const archive = await archiveFixture([...required, "resources/empty/"])

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(
    "Portable package archive does not match the verified unpacked package",
  )
})

test("rejects an EOCD count that hides a valid central directory record", async () => {
  const archive = await archiveFixture([...required, "extra.txt"])
  await rewriteEndOfCentralDirectory(archive, (view, offset) => {
    view.setUint16(offset + 8, required.length, true)
    view.setUint16(offset + 10, required.length, true)
  })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects trailing bytes in the declared central directory span", async () => {
  const archive = await archiveFixture(required)
  await insertCentralDirectoryByte(archive)

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a central directory record that crosses its declared span", async () => {
  const archive = await archiveFixture(required)
  await extendFirstCentralRecordExtraField(archive)

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a local header name that differs from its central directory name", async () => {
  const archive = await archiveFixture(required)
  await rewriteLocalEntryName(archive, "resources/app.asar", "../evil/evil2.asar")

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a local header general-purpose flag mismatch", async () => {
  const archive = await archiveFixture(required)
  await rewriteLocalHeader(archive, "Company OpenCode Pilot.exe", (view, offset) => {
    view.setUint16(offset + 6, view.getUint16(offset + 6, true) ^ 0x800, true)
  })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a local header compression method mismatch", async () => {
  const archive = await archiveFixture(required)
  await rewriteLocalHeader(archive, "Company OpenCode Pilot.exe", (view, offset) => {
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) === 0 ? 8 : 0, true)
  })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a local header DOS timestamp mismatch", async () => {
  const archive = await archiveFixture(required)
  await rewriteLocalHeader(archive, "Company OpenCode Pilot.exe", (view, offset) => {
    view.setUint16(offset + 10, view.getUint16(offset + 10, true) ^ 1, true)
    view.setUint16(offset + 12, view.getUint16(offset + 12, true) ^ 1, true)
  })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects a local Unicode-path extra field", async () => {
  const archive = await archiveFixture(required)
  await insertLocalExtraField(
    archive,
    "resources/app.asar",
    0x7075,
    unicodePathExtraField("resources/app.asar", "../evil/evil2.asar"),
  )

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects archive timestamp extra fields", async () => {
  const archive = await archiveFixture(required, {}, {}, { extendedTimestamp: true })

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects central directory entry comments", async () => {
  const archive = await archiveFixture(required)
  await insertCentralDirectoryComment(archive, "comment")

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects end of central directory comments", async () => {
  const archive = await archiveFixture(required)
  await appendEndOfCentralDirectoryComment(archive, "comment")

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects an undeclared local Setup.exe record before the central directory", async () => {
  const archive = await archiveFixture(required)
  await insertBeforeCentralDirectory(archive, localFileRecord("Setup.exe", "installer payload"))

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
})

test("rejects an unexplained gap before the central directory", async () => {
  const archive = await archiveFixture(required)
  await insertBeforeCentralDirectory(archive, new Uint8Array([0]))

  await expect(verifyEnterpriseArchive(archive)).rejects.toThrow("Portable package archive contains an unsafe entry")
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

test.each([
  ["an empty executable", "Company OpenCode Pilot.exe", "", "Portable package executable"],
  [
    "a different guide",
    "resources/enterprise/company-guide.md",
    "# Different company guide\n",
    "Portable package guide",
  ],
])("rejects %s shared by the archive and unpacked package", async (_name, entry, contents, error) => {
  const root = await portableFixture()
  await Bun.write(path.join(root, entry), contents)
  const archive = await archiveFixture(required, { [entry]: contents })

  await expect(verifyEnterpriseArchive(archive, root)).rejects.toThrow(error)
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
    ...Object.entries(packSkills).map(([id, skill]) =>
      mkdir(path.join(root, `resources/enterprise/skill-packs/${id}/skills/${skillName(id)}`), { recursive: true }),
    ),
  ])
  await Promise.all([
    Bun.write(path.join(root, "Company OpenCode Pilot.exe"), "portable executable"),
    Bun.write(path.join(root, "resources/app.asar"), "application archive"),
    Bun.write(
      path.join(root, "resources/enterprise/opencode.jsonc"),
      enterpriseDefaults,
    ),
    Bun.write(path.join(root, "resources/enterprise/company-guide.md"), enterpriseGuide),
    Bun.write(path.join(root, "resources/enterprise/models.json"), enterpriseModels),
    Bun.write(path.join(root, "resources/enterprise/enterprise-manifest.json"), enterpriseManifest()),
    Bun.write(path.join(root, "resources/enterprise/skill-packs.json"), enterpriseSkillPacks),
    ...Object.entries(packSkills).flatMap(([id, contents]) => [
      Bun.write(path.join(root, `resources/enterprise/skill-packs/${id}/LICENSE`), packLicense),
      Bun.write(
        path.join(root, `resources/enterprise/skill-packs/${id}/skills/${skillName(id)}/SKILL.md`),
        contents,
      ),
    ]),
    Bun.write(path.join(root, "resources/licenses/OpenCode-LICENSE"), "MIT License\n"),
  ])
}

async function writePortableFile(root: string, relative: string, contents: string) {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, contents)
}

async function archiveFixture(
  entries: string[],
  contents: Record<string, string> = {},
  options: Record<string, ZipWriterAddDataOptions> = {},
  writerOptions: { extendedTimestamp?: boolean } = {},
) {
  const root = await temporaryDirectory("enterprise-portable-archive-")
  const writer = new ZipWriter(new BlobWriter("application/zip"), { extendedTimestamp: false, ...writerOptions })
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

async function rewriteLocalEntryName(archive: string, source: string, target: string) {
  const sourceBytes = new TextEncoder().encode(source)
  const targetBytes = new TextEncoder().encode(target)
  if (sourceBytes.byteLength !== targetBytes.byteLength)
    throw new Error("Archive entry names must have the same length")
  await rewriteLocalHeader(archive, source, (view, offset) => {
    new Uint8Array(view.buffer, offset + 30, sourceBytes.byteLength).set(targetBytes)
  })
}

async function rewriteLocalHeader(archive: string, name: string, rewrite: (view: DataView, offset: number) => void) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  rewrite(new DataView(bytes.buffer), localHeaderOffset(bytes, name))
  await Bun.write(archive, bytes)
}

async function insertLocalExtraField(archive: string, name: string, type: number, data: Uint8Array) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const offset = localHeaderOffset(bytes, name)
  const view = new DataView(bytes.buffer)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const extra = new Uint8Array(4 + data.byteLength)
  const extraView = new DataView(extra.buffer)
  extraView.setUint16(0, type, true)
  extraView.setUint16(2, data.byteLength, true)
  extra.set(data, 4)
  const extraOffset = offset + 30 + nameLength
  const result = new Uint8Array(bytes.byteLength + extra.byteLength)
  result.set(bytes.subarray(0, extraOffset + extraLength))
  result.set(extra, extraOffset + extraLength)
  result.set(bytes.subarray(extraOffset + extraLength), extraOffset + extraLength + extra.byteLength)
  const resultView = new DataView(result.buffer)
  resultView.setUint16(offset + 28, extraLength + extra.byteLength, true)
  const originalEndOffset = endOfCentralDirectoryOffset(bytes)
  const endOffset = originalEndOffset + extra.byteLength
  const centralOffset = view.getUint32(originalEndOffset + 16, true) + extra.byteLength
  resultView.setUint32(endOffset + 16, centralOffset, true)
  for (let central = centralOffset; central < endOffset; ) {
    const centralNameLength = resultView.getUint16(central + 28, true)
    const centralExtraLength = resultView.getUint16(central + 30, true)
    const centralCommentLength = resultView.getUint16(central + 32, true)
    if (resultView.getUint32(central + 42, true) > offset)
      resultView.setUint32(central + 42, resultView.getUint32(central + 42, true) + extra.byteLength, true)
    central += 46 + centralNameLength + centralExtraLength + centralCommentLength
  }
  await Bun.write(archive, result)
}

function localHeaderOffset(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer)
  const target = new TextEncoder().encode(name)
  const end = endOfCentralDirectoryOffset(bytes)
  for (let offset = view.getUint32(end + 16, true); offset < end; ) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (nameLength === target.byteLength && target.every((byte, index) => bytes[offset + 46 + index] === byte))
      return view.getUint32(offset + 42, true)
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`Archive does not contain ${name}`)
}

async function rewriteEndOfCentralDirectory(archive: string, rewrite: (view: DataView, offset: number) => void) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  rewrite(new DataView(bytes.buffer), endOfCentralDirectoryOffset(bytes))
  await Bun.write(archive, bytes)
}

async function insertCentralDirectoryByte(archive: string) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const offset = endOfCentralDirectoryOffset(bytes)
  const view = new DataView(bytes.buffer)
  const result = new Uint8Array(bytes.byteLength + 1)
  result.set(bytes.subarray(0, offset))
  result[offset] = 0
  result.set(bytes.subarray(offset), offset + 1)
  new DataView(result.buffer).setUint32(offset + 13, view.getUint32(offset + 12, true) + 1, true)
  await Bun.write(archive, result)
}

async function insertCentralDirectoryComment(archive: string, comment: string) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const end = endOfCentralDirectoryOffset(bytes)
  const view = new DataView(bytes.buffer)
  const central = view.getUint32(end + 16, true)
  const commentBytes = new TextEncoder().encode(comment)
  const commentOffset = central + 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true)
  const result = new Uint8Array(bytes.byteLength + commentBytes.byteLength)
  result.set(bytes.subarray(0, commentOffset))
  result.set(commentBytes, commentOffset)
  result.set(bytes.subarray(commentOffset), commentOffset + commentBytes.byteLength)
  const resultView = new DataView(result.buffer)
  resultView.setUint16(central + 32, commentBytes.byteLength, true)
  resultView.setUint32(
    end + commentBytes.byteLength + 12,
    view.getUint32(end + 12, true) + commentBytes.byteLength,
    true,
  )
  await Bun.write(archive, result)
}

async function appendEndOfCentralDirectoryComment(archive: string, comment: string) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const commentBytes = new TextEncoder().encode(comment)
  const result = new Uint8Array(bytes.byteLength + commentBytes.byteLength)
  result.set(bytes)
  result.set(commentBytes, bytes.byteLength)
  new DataView(result.buffer).setUint16(endOfCentralDirectoryOffset(bytes) + 20, commentBytes.byteLength, true)
  await Bun.write(archive, result)
}

async function insertBeforeCentralDirectory(archive: string, payload: Uint8Array) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const end = endOfCentralDirectoryOffset(bytes)
  const view = new DataView(bytes.buffer)
  const central = view.getUint32(end + 16, true)
  const result = new Uint8Array(bytes.byteLength + payload.byteLength)
  result.set(bytes.subarray(0, central))
  result.set(payload, central)
  result.set(bytes.subarray(central), central + payload.byteLength)
  new DataView(result.buffer).setUint32(end + payload.byteLength + 16, central + payload.byteLength, true)
  await Bun.write(archive, result)
}

async function extendFirstCentralRecordExtraField(archive: string) {
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const view = new DataView(bytes.buffer)
  view.setUint16(view.getUint32(endOfCentralDirectoryOffset(bytes) + 16, true) + 30, 0xffff, true)
  await Bun.write(archive, bytes)
}

function endOfCentralDirectoryOffset(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer)
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 22 - 0xffff); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    )
      return offset
  }
  throw new Error("Archive does not contain an end of central directory record")
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

function localFileRecord(filename: string, contents: string) {
  const name = new TextEncoder().encode(filename)
  const data = new TextEncoder().encode(contents)
  const record = new Uint8Array(30 + name.byteLength + data.byteLength)
  const view = new DataView(record.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x800, true)
  view.setUint16(8, 0, true)
  view.setUint32(14, crc32(data), true)
  view.setUint32(18, data.byteLength, true)
  view.setUint32(22, data.byteLength, true)
  view.setUint16(26, name.byteLength, true)
  record.set(name, 30)
  record.set(data, 30 + name.byteLength)
  return record
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
  "resources/enterprise/opencode.jsonc": enterpriseDefaults,
  "resources/enterprise/company-guide.md": enterpriseGuide,
  "resources/enterprise/models.json": enterpriseModels,
  "resources/enterprise/enterprise-manifest.json": enterpriseManifest(),
  "resources/enterprise/skill-packs.json": enterpriseSkillPacks,
  "resources/enterprise/skill-packs/ponytail/LICENSE": packLicense,
  "resources/enterprise/skill-packs/ponytail/skills/ponytail/SKILL.md": packSkills.ponytail,
  "resources/enterprise/skill-packs/caveman/LICENSE": packLicense,
  "resources/enterprise/skill-packs/caveman/skills/caveman/SKILL.md": packSkills.caveman,
  "resources/enterprise/skill-packs/superpowers/LICENSE": packLicense,
  "resources/enterprise/skill-packs/superpowers/skills/using-superpowers/SKILL.md": packSkills.superpowers,
  "resources/licenses/OpenCode-LICENSE": "MIT License\n",
}

function enterpriseManifest() {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  const identity = enterpriseModelCatalogIdentity(enterpriseModelCatalog)
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      appVersion: "1.17.18",
      defaultsVersion: "pilot-1",
      guideVersion: "pilot-1",
      catalogVersion: "pilot-1",
      defaultModelID: "company-code",
      modelIDs: identity.modelIDs,
      modelCatalogSHA256: identity.sha256,
      allowedOrigins: ["https://llm.corp.example"],
      resources: {
        "company-guide.md": digest(enterpriseGuide),
        "models.json": digest(enterpriseModels),
        "opencode.jsonc": digest(enterpriseDefaults),
        "skill-packs.json": digest(enterpriseSkillPacks),
      },
    },
    null,
    2,
  )}\n`
}

function testPack(id: keyof typeof packSkills, displayName: string, version: string, defaultEnabled: boolean, member: string) {
  return {
    id,
    displayName,
    description: "Test pack.",
    version,
    repository: `https://github.com/example/${id}`,
    defaultEnabled,
    root: `skill-packs/${id}/skills`,
    members: [member],
    license: `skill-packs/${id}/LICENSE`,
    treeSHA256: createHash("sha256")
      .update(
        `LICENSE\0${createHash("sha256").update(packLicense).digest("hex")}\n` +
          `skills/${member}/SKILL.md\0${createHash("sha256").update(packSkills[id]).digest("hex")}\n`,
      )
      .digest("hex"),
  }
}

function skillName(id: string) {
  return id === "superpowers" ? "using-superpowers" : id
}
