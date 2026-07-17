import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"

export type EnterpriseSkillPack = {
  id: string
  displayName: string
  description: string
  version: string
  repository: string
  defaultEnabled: boolean
  root: string
  members: string[]
  license: string
  treeSHA256: string
}

export type VerifiedEnterpriseSkillPack = EnterpriseSkillPack & {
  root: string
  license: string
}

export type EnterpriseSkillPackInfo = Omit<VerifiedEnterpriseSkillPack, "defaultEnabled" | "treeSHA256"> & {
  enabled: boolean
}

export class EnterpriseSkillPackError extends Error {
  constructor(readonly code: "restart_failed_rolled_back" | "restart_failed_recovery_failed") {
    super(code)
    this.name = "EnterpriseSkillPackError"
  }
}

export async function verifyEnterpriseSkillPacks(enterpriseDir: string) {
  const catalog = decodeCatalog(await readFile(path.join(enterpriseDir, "skill-packs.json"), "utf8"))
  const packs = await Promise.all(
    catalog.packs.map(async (pack) => {
      const root = resolveRelative(enterpriseDir, pack.root)
      const license = resolveRelative(enterpriseDir, pack.license)
      const packDir = resolveRelative(enterpriseDir, `skill-packs/${pack.id}`)
      if (!isWithin(packDir, root) || !isWithin(packDir, license)) invalid()
      await Promise.all([path.join(enterpriseDir, "skill-packs"), packDir, root].map(requireDirectory))
      const licenseInfo = await lstat(license).catch(() => undefined)
      if (!licenseInfo?.isFile() || licenseInfo.isSymbolicLink()) invalid()
      if ((await skillPackTreeHash(packDir)) !== pack.treeSHA256) invalid()
      const members = await readMembers(root)
      if (!same(members, pack.members)) invalid()
      return { ...pack, root, license }
    }),
  )
  const members = packs.flatMap((pack) => pack.members)
  if (new Set(members).size !== members.length) invalid()
  return { schemaVersion: 1 as const, packs }
}

export async function skillPackTreeHash(root: string) {
  const files = await treeFiles(root)
  return createHash("sha256")
    .update(
      (
        await Promise.all(
          files.map(async (file) => {
            const relative = path.relative(root, file).split(path.sep).join("/")
            return `${relative}\0${createHash("sha256").update(await readFile(file)).digest("hex")}\n`
          }),
        )
      ).join(""),
    )
    .digest("hex")
}

export function resolveEnterpriseSkillPackState(
  packs: Pick<EnterpriseSkillPack, "id" | "defaultEnabled">[],
  stored: unknown,
) {
  const values = isRecord(stored) ? stored : {}
  return Object.fromEntries(
    packs.map((pack) => {
      const value = values[pack.id]
      return [pack.id, typeof value === "boolean" ? value : pack.defaultEnabled]
    }),
  )
}

export function createEnterpriseSkillPackController(input: {
  packs: VerifiedEnterpriseSkillPack[]
  read: () => unknown
  write: (value: Record<string, boolean>) => Promise<void> | void
  restart: (paths: string[]) => Promise<void>
}) {
  let pending = false
  const state = () => resolveEnterpriseSkillPackState(input.packs, input.read())
  const paths = (value: Record<string, boolean>) => input.packs.flatMap((pack) => (value[pack.id] ? [pack.root] : []))
  const list = (): EnterpriseSkillPackInfo[] => {
    const enabled = state()
    return input.packs.map((pack) => ({
      id: pack.id,
      displayName: pack.displayName,
      description: pack.description,
      version: pack.version,
      repository: pack.repository,
      root: pack.root,
      members: pack.members,
      license: pack.license,
      enabled: enabled[pack.id],
    }))
  }
  const setEnabled = async (id: string, enabled: boolean) => {
    if (typeof id !== "string" || typeof enabled !== "boolean") throw new Error("Enterprise skill pack update is invalid")
    if (pending) throw new Error("Enterprise skill pack update is already in progress")
    if (!input.packs.some((pack) => pack.id === id)) throw new Error("Enterprise skill pack is unavailable")
    const previous = state()
    if (previous[id] === enabled) return list()
    const next = { ...previous, [id]: enabled }
    pending = true
    try {
      await input.write(next)
      await input.restart(paths(next))
      return list()
    } catch {
      await input.write(previous)
      try {
        await input.restart(paths(previous))
      } catch {
        throw new EnterpriseSkillPackError("restart_failed_recovery_failed")
      }
      throw new EnterpriseSkillPackError("restart_failed_rolled_back")
    } finally {
      pending = false
    }
  }
  return { list, setEnabled }
}

export async function openEnterpriseSkillPackSource(
  packs: VerifiedEnterpriseSkillPack[],
  id: string,
  open: (repository: string) => Promise<void> | void,
) {
  if (typeof id !== "string") throw new Error("Enterprise skill pack is unavailable")
  const pack = packs.find((item) => item.id === id)
  if (!pack) throw new Error("Enterprise skill pack is unavailable")
  await open(pack.repository)
}

async function readMembers(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => invalid())
  return (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) invalid()
        const skill = path.join(root, entry.name, "SKILL.md")
        const info = await lstat(skill).catch(() => undefined)
        if (!info?.isFile() || info.isSymbolicLink()) invalid()
        const match = (await readFile(skill, "utf8")).match(/^---\r?\n[\s\S]*?^name:\s*([^\r\n]+)\r?$/m)
        const name = match?.[1].trim().replace(/^['"]|['"]$/g, "")
        if (!name) invalid()
        return name
      }),
    )
  ).sort()
}

async function treeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => invalid())
  return (
    await Promise.all(
      entries
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map(async (entry) => {
          const child = path.join(root, entry.name)
          const info = await lstat(child).catch(() => invalid())
          if (info.isSymbolicLink()) invalid()
          if (info.isDirectory()) return treeFiles(child)
          if (info.isFile()) return [child]
          return invalid()
        }),
    )
  ).flat()
}

async function requireDirectory(directory: string) {
  const info = await lstat(directory).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) invalid()
}

function decodeCatalog(raw: string) {
  const value: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return invalid()
    }
  })()
  if (!isRecord(value) || !hasExactKeys(value, ["packs", "schemaVersion"]) || value.schemaVersion !== 1) invalid()
  if (!Array.isArray(value.packs) || value.packs.length === 0) invalid()
  const packs = value.packs.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, packKeys)) invalid()
    if (
      !text(item.id) ||
      !/^[a-z0-9-]+$/.test(item.id) ||
      !text(item.displayName) ||
      !text(item.description) ||
      !text(item.version) ||
      !text(item.repository) ||
      typeof item.defaultEnabled !== "boolean" ||
      !relative(item.root) ||
      !Array.isArray(item.members) ||
      item.members.some((member) => !text(member)) ||
      !same(item.members as string[], [...(item.members as string[])].sort()) ||
      new Set(item.members).size !== item.members.length ||
      !relative(item.license) ||
      typeof item.treeSHA256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.treeSHA256)
    ) {
      invalid()
    }
    try {
      const repository = new URL(item.repository)
      if (repository.protocol !== "https:" || repository.username || repository.password) invalid()
    } catch {
      invalid()
    }
    return item as EnterpriseSkillPack
  })
  if (new Set(packs.map((pack) => pack.id)).size !== packs.length) invalid()
  return { schemaVersion: 1 as const, packs }
}

const packKeys = [
  "defaultEnabled",
  "description",
  "displayName",
  "id",
  "license",
  "members",
  "repository",
  "root",
  "treeSHA256",
  "version",
]

function resolveRelative(root: string, relative: string) {
  if (!relative.replaceAll("\\", "/").split("/").every((part) => part && part !== "." && part !== "..")) invalid()
  const resolved = path.resolve(root, relative)
  if (!isWithin(path.resolve(root), resolved)) invalid()
  return resolved
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function relative(value: unknown): value is string {
  return text(value) && !path.isAbsolute(value) && !value.includes("\\")
}

function same(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function invalid(): never {
  throw new Error("Enterprise skill pack verification failed")
}
