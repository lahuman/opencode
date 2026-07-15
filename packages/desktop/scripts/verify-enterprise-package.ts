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
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await Bun.file(archive).arrayBuffer())))
  const entries = await reader.getEntries()
  await reader.close()
  const normalizedEntries = entries.map((entry) => normalizeEntry(entry.filename, entry.directory))

  if (normalizedEntries.some((name) => name === undefined)) {
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

function normalizeEntry(value: string, directory: boolean) {
  const name = (directory ? value.slice(0, -1) : value).replaceAll("\\", "/")
  if (
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined
  }
  return name
}

function windowsEntryKey(name: string) {
  return name.toLowerCase()
}

function packageRootNodes(root: string) {
  const packageRoot = path.resolve(root)
  const parent = path.dirname(packageRoot)
  if (parent === packageRoot) return []

  // Production output is <package>/dist/win-unpacked. Stop above the package boundary, but inspect each
  // existing component below it so a linked dist directory cannot redirect the package tree.
  const boundary =
    path.basename(packageRoot) === "win-unpacked" && path.basename(parent) === "dist" ? path.dirname(parent) : parent
  const boundaryIsFileSystemRoot = boundary === path.parse(boundary).root
  const parts = path.relative(boundary, packageRoot).split(path.sep).filter(Boolean)
  return [
    ...(boundaryIsFileSystemRoot ? [] : [{ path: boundary, directory: true }]),
    ...parts.map((_, index) => ({
      path: path.join(boundary, ...parts.slice(0, index + 1)),
      directory: true,
    })),
  ]
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error("Portable package root is required")
  await verifyEnterprisePackage(root)
}
