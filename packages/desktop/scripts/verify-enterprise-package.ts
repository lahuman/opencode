import { access, stat } from "node:fs/promises"
import path from "node:path"
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js"

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
]

export async function verifyEnterprisePackage(root: string): Promise<EnterprisePackageSummary> {
  const files = {
    executable: path.join(root, "Company OpenCode Pilot.exe"),
    defaults: path.join(root, "resources", "enterprise", "opencode.jsonc"),
    guide: path.join(root, "resources", "enterprise", "company-guide.md"),
    models: path.join(root, "resources", "enterprise", "models.json"),
    appArchive: path.join(root, "resources", "app.asar"),
    license: path.join(root, "resources", "licenses", "OpenCode-LICENSE"),
  }
  const exists = await Promise.all(
    Object.values(files).map((file) =>
      access(file).then(
        () => true,
        () => false,
      ),
    ),
  )
  if (!exists.every(Boolean)) throw new Error("Portable package is missing required files")

  const defaults = await Bun.file(files.defaults)
    .json()
    .catch(() => undefined)
  if (
    !isRecord(defaults) ||
    !Array.isArray(defaults.enabled_providers) ||
    !defaults.enabled_providers.includes("company-llm")
  ) {
    throw new Error("Portable package defaults are invalid")
  }

  const models = await Bun.file(files.models)
    .json()
    .catch(() => undefined)
  if (!isRecord(models)) throw new Error("Portable package catalog is invalid")
  if (!(await Bun.file(files.guide).text()).startsWith("# ")) throw new Error("Portable package guide is invalid")
  if ((await stat(files.appArchive)).size === 0) throw new Error("Portable package archive is empty")
  if (!(await Bun.file(files.license).text()).includes("MIT License"))
    throw new Error("Portable package license is invalid")

  return {
    executable: path.basename(files.executable),
    defaults: true,
    guide: true,
    models: true,
    appArchive: true,
    license: true,
  }
}

export async function verifyEnterpriseArchive(archive: string): Promise<string[]> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await Bun.file(archive).arrayBuffer())))
  const entries = await reader.getEntries()
  await reader.close()
  const normalizedEntries = entries.map((entry) => normalizeEntry(entry.filename, entry.directory))

  if (normalizedEntries.some((name) => name === undefined)) {
    throw new Error("Portable package archive contains an unsafe entry")
  }
  const normalized = normalizedEntries.filter((name): name is string => name !== undefined)
  if (new Set(normalized).size !== normalized.length)
    throw new Error("Portable package archive contains duplicate entries")
  const files = entries.flatMap((entry, index) => (entry.directory ? [] : [normalized[index]]))
  if (!requiredEntries.every((entry) => files.includes(entry))) {
    throw new Error("Portable package archive is missing required files")
  }
  if (files.some((entry) => !entry.includes("/") && entry.endsWith(".exe") && entry !== requiredEntries[0])) {
    throw new Error("Portable package archive contains an installer executable")
  }
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeEntry(value: string, directory: boolean) {
  const name = (directory ? value.slice(0, -1) : value).replaceAll("\\", "/")
  if (
    name.startsWith("/") ||
    /^[a-z]:\//i.test(name) ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined
  }
  return name
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error("Portable package root is required")
  await verifyEnterprisePackage(root)
}
