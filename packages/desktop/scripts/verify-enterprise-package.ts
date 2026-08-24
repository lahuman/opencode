import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { type Entry, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { verifyEnterpriseManifestContents } from "../src/main/enterprise-preflight"
import { verifyEnterpriseSkillPacks } from "../src/main/enterprise-skill-packs"

export type EnterprisePackageSummary = {
  executable: string
  defaults: true
  guide: true
  models: true
  manifest: true
  appArchive: true
  license: true
  skillPacks: true
  ripgrep: true
}

const requiredEntries = [
  "CHAI.exe",
  "resources/app.asar",
  "resources/enterprise/opencode.jsonc",
  "resources/enterprise/company-guide.md",
  "resources/enterprise/models.json",
  "resources/enterprise/enterprise-manifest.json",
  "resources/enterprise/skill-packs.json",
  "resources/enterprise/ripgrep/rg.exe",
  "resources/enterprise/ripgrep/LICENSE-MIT",
  "resources/enterprise/ripgrep/UNLICENSE",
  "resources/enterprise/skill-packs/analyze-codebase/LICENSE",
  "resources/enterprise/skill-packs/debug-problems/LICENSE",
  "resources/enterprise/skill-packs/verify-changes/LICENSE",
  "resources/licenses/OpenCode-LICENSE",
] as const
const enterpriseGuide = new Uint8Array(
  await Bun.file(new URL("../resources/enterprise/company-guide.md", import.meta.url)).arrayBuffer(),
)

type RequiredEntry = (typeof requiredEntries)[number]
type EnterprisePackageFiles = Record<RequiredEntry, Uint8Array>
type EnterprisePackageTree = {
  directories: Set<string>
  files: Map<string, string>
  required: EnterprisePackageFiles
}
type CentralDirectory = {
  entries: CentralDirectoryEntry[]
  offset: number
}
type CentralDirectoryEntry = {
  bitFlag: number
  compressedSize: number
  compressionMethod: number
  diskNumberStart: number
  externalFileAttributes: number
  filenameUTF8: boolean
  lastModDate: number
  lastModTime: number
  offset: number
  rawComment: Uint8Array
  rawExtraField: Uint8Array
  rawFilename: Uint8Array
  signature: number
  uncompressedSize: number
  version: number
  versionMadeBy: number
}
type ArchiveRange = { end: number; start: number }

export async function verifyEnterprisePackage(root: string): Promise<EnterprisePackageSummary> {
  validateEnterprisePackageFiles((await readEnterprisePackage(root)).required)
  await verifyEnterpriseSkillPacks(path.join(root, "resources/enterprise"))
  return {
    executable: path.basename(requiredEntries[0]),
    defaults: true,
    guide: true,
    models: true,
    manifest: true,
    appArchive: true,
    license: true,
    skillPacks: true,
    ripgrep: true,
  }
}

export async function verifyEnterpriseArchive(archive: string, root?: string): Promise<string[]> {
  const archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const centralDirectory = readCentralDirectory(archiveBytes)
  if (!centralDirectory) throw new Error("Portable package archive contains an unsafe entry")
  if (!hasSafeLocalHeaders(archiveBytes, centralDirectory)) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  const reader = new ZipReader(new Uint8ArrayReader(archiveBytes))
  const entries = await reader.getEntries()
  await reader.close()
  if (
    entries.length !== centralDirectory.entries.length ||
    !entries.every((entry, index) => matchesCentralDirectoryEntry(entry, centralDirectory.entries[index]))
  ) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  const rawNames = entries.map(readRawCentralName)
  if (rawNames.some((name) => name === undefined)) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  const normalizedEntries = entries.map((entry, index) => normalizeEntry(rawNames[index]!, entry))

  if (normalizedEntries.some((name) => name === undefined)) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  if (entries.some((entry, index) => !isSafeArchiveEntry(entry, rawNames[index]!))) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  const normalized = normalizedEntries.filter((name): name is string => name !== undefined)
  if (new Set(normalized.map(windowsEntryKey)).size !== normalized.length) {
    throw new Error("Portable package archive contains duplicate entries")
  }
  const files = new Map<string, Entry>(
    entries.flatMap((entry, index) => (entry.directory ? [] : [[normalizedEntries[index]!, entry]])),
  )
  if (!requiredEntries.every((entry) => files.has(entry))) {
    throw new Error("Portable package archive is missing required files")
  }
  if (
    Array.from(files.keys()).some(
      (entry) => !entry.includes("/") && entry.toLowerCase().endsWith(".exe") && entry !== requiredEntries[0],
    )
  ) {
    throw new Error("Portable package archive contains an installer executable")
  }

  const contents = await Promise.all(requiredEntries.map((entry) => readArchiveEntry(files.get(entry), entry)))
  const archiveContents = new Map(contents)
  const archiveFiles = requiredFiles((entry) => getRequiredFile(archiveContents, entry))
  validateEnterprisePackageFiles(archiveFiles)
  if (!root) return Array.from(files.keys())

  const unpacked = await readEnterprisePackage(root)
  validateEnterprisePackageFiles(unpacked.required)
  const directories = archiveDirectories(entries, normalizedEntries)
  if (
    !sameEntries(Array.from(files.keys(), windowsEntryKey), unpacked.files.keys()) ||
    !sameEntries(directories, unpacked.directories)
  ) {
    throw new Error("Portable package archive does not match the verified unpacked package")
  }
  for (const [name, entry] of files) {
    const unpackedFile = unpacked.files.get(windowsEntryKey(name))
    if (!unpackedFile || !bytesEqual(await entry.getData(new Uint8ArrayWriter()), await readFile(unpackedFile))) {
      throw new Error("Portable package archive does not match the verified unpacked package")
    }
  }
  return Array.from(files.keys())
}

async function readEnterprisePackage(root: string): Promise<EnterprisePackageTree> {
  const packageRoot = path.resolve(root)
  const stats = await Promise.all(
    packageRootNodes(root).map((node) =>
      lstat(node.path).then(
        (info) => info,
        () => undefined,
      ),
    ),
  )
  if (!stats.every((info) => info && !info.isSymbolicLink() && info.isDirectory())) {
    throw new Error("Portable package is missing required files")
  }
  const files = new Map<string, string>()
  const directories = new Set<string>()
  await readEnterprisePackageDirectory(packageRoot, "", files, directories)
  const contents = new Map(
    await Promise.all(
      requiredEntries.map(async (entry) => {
        const file = files.get(windowsEntryKey(entry))
        if (!file) throw new Error("Portable package is missing required files")
        return [entry, await readFile(file)] as const
      }),
    ),
  )
  return { directories, files, required: requiredFiles((entry) => getRequiredFile(contents, entry)) }
}

async function readEnterprisePackageDirectory(
  directory: string,
  relative: string,
  files: Map<string, string>,
  directories: Set<string>,
) {
  for (const child of await readdir(directory)) {
    const relativePath = relative ? `${relative}/${child}` : child
    const name = normalizeWindowsRelativePath(relativePath)
    const childPath = path.join(directory, child)
    const info = await lstat(childPath)
    if (!name || info.isSymbolicLink()) throw new Error("Portable package is missing required files")
    const key = windowsEntryKey(name)
    if (files.has(key) || directories.has(key)) throw new Error("Portable package is missing required files")
    if (info.isDirectory()) {
      directories.add(key)
      await readEnterprisePackageDirectory(childPath, name, files, directories)
      continue
    }
    if (info.isFile()) {
      files.set(key, childPath)
      continue
    }
    throw new Error("Portable package is missing required files")
  }
}

async function readFile(file: string) {
  return new Uint8Array(await Bun.file(file).arrayBuffer())
}

async function readArchiveEntry(entry: Entry | undefined, name: RequiredEntry) {
  if (!entry?.getData) throw new Error(`Portable package archive is missing ${name}`)
  return [name, await entry.getData(new Uint8ArrayWriter())] as const
}

function validateEnterprisePackageFiles(files: EnterprisePackageFiles) {
  const defaults = parseJSON(files["resources/enterprise/opencode.jsonc"], "Portable package defaults are invalid")
  if (
    !isRecord(defaults) ||
    !Array.isArray(defaults.enabled_providers) ||
    !defaults.enabled_providers.includes("company-llm")
  ) {
    throw new Error("Portable package defaults are invalid")
  }

  const models = parseJSON(files["resources/enterprise/models.json"], "Portable package catalog is invalid")
  if (!isRecord(models)) throw new Error("Portable package catalog is invalid")
  if (!bytesEqual(files["resources/enterprise/company-guide.md"], enterpriseGuide)) {
    throw new Error("Portable package guide is invalid")
  }
  try {
    verifyEnterpriseManifestContents({
      manifest: new TextDecoder().decode(files["resources/enterprise/enterprise-manifest.json"]),
      resources: {
        "opencode.jsonc": files["resources/enterprise/opencode.jsonc"],
        "company-guide.md": files["resources/enterprise/company-guide.md"],
        "models.json": files["resources/enterprise/models.json"],
        "skill-packs.json": files["resources/enterprise/skill-packs.json"],
        "ripgrep/rg.exe": files["resources/enterprise/ripgrep/rg.exe"],
        "ripgrep/LICENSE-MIT": files["resources/enterprise/ripgrep/LICENSE-MIT"],
        "ripgrep/UNLICENSE": files["resources/enterprise/ripgrep/UNLICENSE"],
      },
    })
  } catch {
    throw new Error("Portable package enterprise manifest is invalid")
  }
  if (files["CHAI.exe"].byteLength === 0) throw new Error("Portable package executable is empty")
  if (files["resources/enterprise/ripgrep/rg.exe"].byteLength === 0) {
    throw new Error("Portable package ripgrep executable is empty")
  }
  if (files["resources/app.asar"].byteLength === 0) throw new Error("Portable package archive is empty")
  if (!new TextDecoder().decode(files["resources/licenses/OpenCode-LICENSE"]).includes("MIT License")) {
    throw new Error("Portable package license is invalid")
  }
}

function parseJSON(input: Uint8Array, error: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(input))
  } catch {
    throw new Error(error)
  }
}

function requiredFiles<T>(read: (entry: RequiredEntry) => T): Record<RequiredEntry, T> {
  return {
    "CHAI.exe": read("CHAI.exe"),
    "resources/app.asar": read("resources/app.asar"),
    "resources/enterprise/opencode.jsonc": read("resources/enterprise/opencode.jsonc"),
    "resources/enterprise/company-guide.md": read("resources/enterprise/company-guide.md"),
    "resources/enterprise/models.json": read("resources/enterprise/models.json"),
    "resources/enterprise/enterprise-manifest.json": read("resources/enterprise/enterprise-manifest.json"),
    "resources/enterprise/skill-packs.json": read("resources/enterprise/skill-packs.json"),
    "resources/enterprise/ripgrep/rg.exe": read("resources/enterprise/ripgrep/rg.exe"),
    "resources/enterprise/ripgrep/LICENSE-MIT": read("resources/enterprise/ripgrep/LICENSE-MIT"),
    "resources/enterprise/ripgrep/UNLICENSE": read("resources/enterprise/ripgrep/UNLICENSE"),
    "resources/enterprise/skill-packs/analyze-codebase/LICENSE": read(
      "resources/enterprise/skill-packs/analyze-codebase/LICENSE",
    ),
    "resources/enterprise/skill-packs/debug-problems/LICENSE": read(
      "resources/enterprise/skill-packs/debug-problems/LICENSE",
    ),
    "resources/enterprise/skill-packs/verify-changes/LICENSE": read(
      "resources/enterprise/skill-packs/verify-changes/LICENSE",
    ),
    "resources/licenses/OpenCode-LICENSE": read("resources/licenses/OpenCode-LICENSE"),
  }
}

function getRequiredFile<T>(files: Map<RequiredEntry, T>, entry: RequiredEntry) {
  const file = files.get(entry)
  if (!file) throw new Error(`Portable package is missing ${entry}`)
  return file
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readCentralDirectory(bytes: Uint8Array): CentralDirectory | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOfCentralDirectory = endOfCentralDirectoryOffset(view, bytes.byteLength)
  if (endOfCentralDirectory === undefined) return undefined
  const diskNumber = view.getUint16(endOfCentralDirectory + 4, true)
  const centralDirectoryDisk = view.getUint16(endOfCentralDirectory + 6, true)
  const entriesOnDisk = view.getUint16(endOfCentralDirectory + 8, true)
  const entries = view.getUint16(endOfCentralDirectory + 10, true)
  const size = view.getUint32(endOfCentralDirectory + 12, true)
  const offset = view.getUint32(endOfCentralDirectory + 16, true)
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    view.getUint16(endOfCentralDirectory + 20, true) !== 0 ||
    offset + size !== endOfCentralDirectory
  ) {
    return undefined
  }

  const end = offset + size
  const directory: CentralDirectoryEntry[] = []
  for (let cursor = offset; cursor < end; ) {
    if (end - cursor < 46 || view.getUint32(cursor, true) !== 0x02014b50) return undefined
    const filenameLength = view.getUint16(cursor + 28, true)
    const extraFieldLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const recordEnd = cursor + 46 + filenameLength + extraFieldLength + commentLength
    if (recordEnd > end || commentLength !== 0 || view.getUint16(cursor + 34, true) !== 0) return undefined
    const filenameOffset = cursor + 46
    const extraFieldOffset = filenameOffset + filenameLength
    const commentOffset = extraFieldOffset + extraFieldLength
    const rawExtraField = bytes.slice(extraFieldOffset, commentOffset)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      view.getUint32(cursor + 42, true) === 0xffffffff ||
      !hasSafeArchiveExtraFields(rawExtraField)
    ) {
      return undefined
    }
    directory.push({
      bitFlag: view.getUint16(cursor + 8, true),
      compressedSize,
      compressionMethod: view.getUint16(cursor + 10, true),
      diskNumberStart: 0,
      externalFileAttributes: view.getUint32(cursor + 38, true),
      filenameUTF8: Boolean(view.getUint16(cursor + 8, true) & 0x800),
      lastModDate: view.getUint16(cursor + 14, true),
      lastModTime: view.getUint16(cursor + 12, true),
      offset: view.getUint32(cursor + 42, true),
      rawComment: bytes.slice(commentOffset, recordEnd),
      rawExtraField,
      rawFilename: bytes.slice(filenameOffset, extraFieldOffset),
      signature: view.getUint32(cursor + 16, true),
      uncompressedSize,
      version: view.getUint16(cursor + 6, true),
      versionMadeBy: view.getUint16(cursor + 4, true),
    })
    cursor = recordEnd
  }
  return directory.length === entries ? { entries: directory, offset } : undefined
}

function endOfCentralDirectoryOffset(view: DataView, length: number) {
  for (let offset = length - 22; offset >= Math.max(0, length - 22 - 0xffff); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === length)
      return offset
  }
  return undefined
}

function matchesCentralDirectoryEntry(entry: Entry, central: CentralDirectoryEntry) {
  return (
    entry.diskNumberStart === central.diskNumberStart &&
    entry.externalFileAttributes === central.externalFileAttributes &&
    entry.filenameUTF8 === central.filenameUTF8 &&
    entry.offset === central.offset &&
    entry.versionMadeBy === central.versionMadeBy &&
    bytesEqual(entry.rawComment, central.rawComment) &&
    bytesEqual(entry.rawExtraField, central.rawExtraField) &&
    bytesEqual(entry.rawFilename, central.rawFilename)
  )
}

function hasSafeLocalHeaders(bytes: Uint8Array, centralDirectory: CentralDirectory) {
  const ranges = centralDirectory.entries
    .map((entry) => readLocalHeader(bytes, centralDirectory.offset, entry))
    .filter((range): range is ArchiveRange => range !== undefined)
  if (ranges.length !== centralDirectory.entries.length) return false
  const sorted = ranges.toSorted((left, right) => left.start - right.start)
  // Controlled Windows release ZIPs have no self-extracting prefix or undeclared local payload.
  return (
    sorted[0].start === 0 &&
    sorted[sorted.length - 1].end === centralDirectory.offset &&
    sorted.every((range, index) => index === 0 || sorted[index - 1].end === range.start)
  )
}

function readLocalHeader(bytes: Uint8Array, centralDirectoryOffset: number, central: CentralDirectoryEntry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (central.offset + 30 > centralDirectoryOffset || view.getUint32(central.offset, true) !== 0x04034b50)
    return undefined
  const bitFlag = view.getUint16(central.offset + 6, true)
  const compressionMethod = view.getUint16(central.offset + 8, true)
  const filenameLength = view.getUint16(central.offset + 26, true)
  const extraFieldLength = view.getUint16(central.offset + 28, true)
  const filenameOffset = central.offset + 30
  const extraFieldOffset = filenameOffset + filenameLength
  const dataOffset = extraFieldOffset + extraFieldLength
  if (dataOffset > centralDirectoryOffset) return undefined
  const rawFilename = bytes.slice(filenameOffset, extraFieldOffset)
  const rawExtraField = bytes.slice(extraFieldOffset, dataOffset)
  if (
    view.getUint16(central.offset + 4, true) !== central.version ||
    bitFlag !== central.bitFlag ||
    compressionMethod !== central.compressionMethod ||
    view.getUint16(central.offset + 10, true) !== central.lastModTime ||
    view.getUint16(central.offset + 12, true) !== central.lastModDate ||
    !bytesEqual(rawFilename, central.rawFilename) ||
    !bytesEqual(rawExtraField, central.rawExtraField) ||
    !hasSafeArchiveExtraFields(rawExtraField) ||
    isDirectoryName(rawFilename) !== isDirectoryName(central.rawFilename)
  ) {
    return undefined
  }
  const dataEnd = dataOffset + central.compressedSize
  if (dataEnd > centralDirectoryOffset) return undefined
  if (!(central.bitFlag & 0x8)) {
    if (
      view.getUint32(central.offset + 14, true) !== central.signature ||
      view.getUint32(central.offset + 18, true) !== central.compressedSize ||
      view.getUint32(central.offset + 22, true) !== central.uncompressedSize
    ) {
      return undefined
    }
    return { start: central.offset, end: dataEnd }
  }
  if (
    view.getUint32(central.offset + 14, true) !== 0 ||
    view.getUint32(central.offset + 18, true) !== 0 ||
    view.getUint32(central.offset + 22, true) !== 0
  ) {
    return undefined
  }
  const dataDescriptorEnd = readDataDescriptor(view, dataEnd, centralDirectoryOffset, central)
  if (dataDescriptorEnd === undefined) return undefined
  return { start: central.offset, end: dataDescriptorEnd }
}

function readDataDescriptor(
  view: DataView,
  offset: number,
  centralDirectoryOffset: number,
  central: CentralDirectoryEntry,
) {
  const descriptorOffset =
    offset + (offset + 4 <= centralDirectoryOffset && view.getUint32(offset, true) === 0x08074b50 ? 4 : 0)
  if (descriptorOffset + 12 > centralDirectoryOffset) return undefined
  if (
    view.getUint32(descriptorOffset, true) !== central.signature ||
    view.getUint32(descriptorOffset + 4, true) !== central.compressedSize ||
    view.getUint32(descriptorOffset + 8, true) !== central.uncompressedSize
  ) {
    return undefined
  }
  return descriptorOffset + 12
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function isDirectoryName(name: Uint8Array) {
  return name.byteLength > 0 && name[name.byteLength - 1] === 0x2f
}

function readRawCentralName(entry: Entry) {
  if (!entry.filenameUTF8 || !entry.rawFilename.every((byte) => byte >= 0x20 && byte <= 0x7e)) return undefined
  if (!hasSafeArchiveExtraFields(entry.rawExtraField)) return undefined
  const name = new TextDecoder("utf-8", { fatal: true }).decode(entry.rawFilename)
  if (name !== entry.filename || name.includes("\\")) return undefined
  return name
}

function hasSafeArchiveExtraFields(extra: Uint8Array) {
  return extra.byteLength === 0
}

function normalizeEntry(value: string, entry: Entry) {
  const directory = value.endsWith("/")
  if (directory !== entry.directory) return undefined
  const name = directory ? value.slice(0, -1) : value
  return normalizeWindowsRelativePath(name)
}

function normalizeWindowsRelativePath(name: string) {
  if (name.startsWith("/") || /^[a-z]:/i.test(name) || name.includes("\\")) return undefined
  const components = name.split("/")
  if (!components.every(isSafeWindowsPathComponent)) return undefined
  return components.join("/")
}

function windowsEntryKey(name: string) {
  return name
    .split("/")
    .map((component) => component.replace(/[A-Z]/g, (character) => character.toLowerCase()))
    .join("/")
}

function packageRootNodes(root: string) {
  const packageRoot = path.resolve(root)
  const filesystemRoot = path.parse(packageRoot).root
  const nodes = []
  for (let current = packageRoot; current !== filesystemRoot; current = path.dirname(current)) {
    nodes.push({ path: current, directory: true })
  }
  // Walk lexical ancestors so lstat sees a link before resolving a child through it. The filesystem root is excluded.
  return nodes.reverse()
}

function archiveDirectories(entries: Entry[], names: (string | undefined)[]) {
  return new Set(
    names.flatMap((name, index) => {
      if (!name) return []
      const components = name.split("/")
      return components
        .slice(0, entries[index].directory ? components.length : -1)
        .map((_, component) => windowsEntryKey(components.slice(0, component + 1).join("/")))
    }),
  )
}

function sameEntries(left: Iterable<string>, right: Iterable<string>) {
  const leftEntries = new Set(left)
  const rightEntries = new Set(right)
  return leftEntries.size === rightEntries.size && Array.from(leftEntries).every((entry) => rightEntries.has(entry))
}

function isSafeWindowsPathComponent(component: string) {
  if (
    component === "" ||
    component === "." ||
    component === ".." ||
    component.startsWith(" ") ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
    !/^[\x20-\x7e]+$/.test(component) ||
    /[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(component)
  ) {
    return false
  }
  const basename = component.split(".", 1)[0]
  return !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(
    basename,
  )
}

function isSafeArchiveEntry(entry: Entry, name: string) {
  // The release ZIP is built with Windows 7za and extracted with Expand-Archive, so accept only MS-DOS metadata.
  if (entry.versionMadeBy >> 8 !== 0) return false
  const directory = name.endsWith("/")
  return directory === Boolean(entry.externalFileAttributes & 0x10)
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error("Portable package root is required")
  await verifyEnterprisePackage(root)
}
