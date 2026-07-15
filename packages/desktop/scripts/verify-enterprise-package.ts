import { lstat } from "node:fs/promises"
import path from "node:path"
import { type Entry, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"

export type EnterprisePackageSummary = {
  executable: string
  defaults: true
  guide: true
  models: true
  appArchive: true
  license: true
}

const requiredEntries = [
  "Company OpenCode Pilot.exe",
  "resources/app.asar",
  "resources/enterprise/opencode.jsonc",
  "resources/enterprise/company-guide.md",
  "resources/enterprise/models.json",
  "resources/licenses/OpenCode-LICENSE",
] as const

type RequiredEntry = (typeof requiredEntries)[number]
type EnterprisePackageFiles = Record<RequiredEntry, Uint8Array>
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
  validateEnterprisePackageFiles(await readEnterprisePackage(root))
  return {
    executable: path.basename(requiredEntries[0]),
    defaults: true,
    guide: true,
    models: true,
    appArchive: true,
    license: true,
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

  const unpackedFiles = await readEnterprisePackage(root)
  validateEnterprisePackageFiles(unpackedFiles)
  if (requiredEntries.some((entry) => hash(archiveFiles[entry]) !== hash(unpackedFiles[entry]))) {
    throw new Error("Portable package archive does not match the verified unpacked package")
  }
  return Array.from(files.keys())
}

async function readEnterprisePackage(root: string): Promise<EnterprisePackageFiles> {
  const paths = requiredFiles((entry) => path.join(root, ...entry.split("/")))
  const nodes = [
    ...packageRootNodes(root),
    ...requiredEntries.flatMap((entry) => {
      const parts = entry.split("/")
      return parts.map((_, index) => ({
        path: path.join(root, ...parts.slice(0, index + 1)),
        directory: index < parts.length - 1,
      }))
    }),
  ]
  // lstat observes the link itself so a payload cannot escape win-unpacked through a link or junction.
  const stats = await Promise.all(
    nodes.map((node) =>
      lstat(node.path).then(
        (info) => info,
        () => undefined,
      ),
    ),
  )
  if (
    !stats.every(
      (info, index) => info && !info.isSymbolicLink() && (nodes[index].directory ? info.isDirectory() : info.isFile()),
    )
  ) {
    throw new Error("Portable package is missing required files")
  }
  const contents = new Map(
    await Promise.all(
      requiredEntries.map(
        async (entry) => [entry, new Uint8Array(await Bun.file(paths[entry]).arrayBuffer())] as const,
      ),
    ),
  )
  return requiredFiles((entry) => getRequiredFile(contents, entry))
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
  if (!new TextDecoder().decode(files["resources/enterprise/company-guide.md"]).startsWith("# ")) {
    throw new Error("Portable package guide is invalid")
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

function hash(input: Uint8Array) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

function requiredFiles<T>(read: (entry: RequiredEntry) => T): Record<RequiredEntry, T> {
  return {
    "Company OpenCode Pilot.exe": read("Company OpenCode Pilot.exe"),
    "resources/app.asar": read("resources/app.asar"),
    "resources/enterprise/opencode.jsonc": read("resources/enterprise/opencode.jsonc"),
    "resources/enterprise/company-guide.md": read("resources/enterprise/company-guide.md"),
    "resources/enterprise/models.json": read("resources/enterprise/models.json"),
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
    if (recordEnd > end || view.getUint16(cursor + 34, true) !== 0) return undefined
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
  let offset = 0
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) return false
    const type = extra[offset] | (extra[offset + 1] << 8)
    const length = extra[offset + 2] | (extra[offset + 3] << 8)
    offset += 4
    if (offset + length > extra.byteLength || (type !== 0x000a && type !== 0x5455)) return false
    offset += length
  }
  return true
}

function normalizeEntry(value: string, entry: Entry) {
  const directory = value.endsWith("/")
  if (directory !== entry.directory) return undefined
  const name = directory ? value.slice(0, -1) : value
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) {
    return undefined
  }
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

function isSafeWindowsPathComponent(component: string) {
  if (
    component === "" ||
    component === "." ||
    component === ".." ||
    component.startsWith(" ") ||
    component.endsWith(".") ||
    component.endsWith(" ") ||
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
