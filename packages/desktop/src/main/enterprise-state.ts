import { randomUUID } from "node:crypto"
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const metadataName = "enterprise-state.json"
const backupsName = "enterprise-backups"
const stateSchemaVersion = 1
const excluded = new Set(
  [
    backupsName,
    "enterprise-legacy-adoption.json",
    "drafts.sqlite",
    "drafts.sqlite-wal",
    "drafts.sqlite-shm",
    "logs",
    "cache",
    "Crashpad",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "Network",
    "Session Storage",
  ].map((name) => name.toLowerCase()),
)

export type EnterpriseStateMetadataV1 = {
  schemaVersion: 1
  stateSchemaVersion: 1
  lastSuccessfulAppVersion?: string
  pendingAppVersion?: string
  pendingBackupID?: string
  backups: { id: string; appVersion: string; createdAt: string; compatibility?: "unknown" }[]
}

export type EnterpriseStateFailure = "metadata_invalid" | "downgrade" | "backup_failed" | "recovery_required"

export class EnterpriseStateError extends Error {
  constructor(
    readonly kind: EnterpriseStateFailure,
    message: string,
  ) {
    super(message)
    this.name = "EnterpriseStateError"
  }
}

export async function prepareEnterpriseState(input: {
  enabled: boolean
  userData: string
  appVersion: string
  now?: Date
}) {
  if (!input.enabled) return { status: "ready" as const, backupID: undefined }
  requireVersion(input.appVersion)
  await mkdir(input.userData, { recursive: true })
  const current = await readEnterpriseStateMetadata(input.userData)
  if (!current) {
    const durable = (await readdir(input.userData, { withFileTypes: true })).filter(
      (entry) => !excluded.has(entry.name.toLowerCase()) && entry.name !== metadataName,
    )
    const createdAt = (input.now ?? new Date()).toISOString()
    const backupID = durable.length ? `${stamp(new Date(createdAt))}-bootstrap` : undefined
    if (backupID) await createBackup(input.userData, backupID)
    await writeMetadata(input.userData, {
      schemaVersion: 1,
      stateSchemaVersion,
      pendingAppVersion: input.appVersion,
      ...(backupID ? { pendingBackupID: backupID } : {}),
      backups: backupID ? [{ id: backupID, appVersion: "0.0.0", createdAt, compatibility: "unknown" }] : [],
    })
    return { status: "pending" as const, backupID }
  }
  if (current.stateSchemaVersion > stateSchemaVersion) {
    throw new EnterpriseStateError("downgrade", "Enterprise state was created by a newer application")
  }
  if (current.lastSuccessfulAppVersion && compareVersions(current.lastSuccessfulAppVersion, input.appVersion) > 0) {
    throw new EnterpriseStateError("downgrade", "Enterprise state was created by a newer application")
  }
  if (current.pendingAppVersion) {
    if (current.pendingAppVersion !== input.appVersion) {
      throw new EnterpriseStateError("recovery_required", "Enterprise state recovery is required before continuing")
    }
    if (current.pendingBackupID) {
      throw new EnterpriseStateError("recovery_required", "Enterprise state recovery is required before continuing")
    }
    return { status: "pending" as const, backupID: current.pendingBackupID }
  }
  if (current.lastSuccessfulAppVersion === input.appVersion) {
    return { status: "ready" as const, backupID: undefined }
  }

  const previous = current.lastSuccessfulAppVersion
  if (!previous) {
    await writeMetadata(input.userData, { ...current, pendingAppVersion: input.appVersion })
    return { status: "pending" as const, backupID: undefined }
  }
  const createdAt = (input.now ?? new Date()).toISOString()
  const backupID = `${stamp(new Date(createdAt))}-${previous}`
  await createBackup(input.userData, backupID)
  const backups = [...current.backups, { id: backupID, appVersion: previous, createdAt }]
  const retained = backups.slice(-3)
  await writeMetadata(input.userData, {
    ...current,
    pendingAppVersion: input.appVersion,
    pendingBackupID: backupID,
    backups: retained,
  })
  await Promise.all(
    backups
      .slice(0, -3)
      .map((backup) => rm(join(input.userData, backupsName, backup.id), { recursive: true, force: true })),
  )
  return { status: "pending" as const, backupID }
}

export async function markEnterpriseStateHealthy(input: { enabled: boolean; userData: string; appVersion: string }) {
  if (!input.enabled) return
  requireVersion(input.appVersion)
  const current = await readEnterpriseStateMetadata(input.userData)
  if (!current) throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata is missing")
  if (current.pendingAppVersion && current.pendingAppVersion !== input.appVersion) {
    throw new EnterpriseStateError("recovery_required", "Enterprise state recovery is required before continuing")
  }
  const { pendingAppVersion: _pendingAppVersion, pendingBackupID: _pendingBackupID, ...metadata } = current
  await writeMetadata(input.userData, { ...metadata, lastSuccessfulAppVersion: input.appVersion })
}

export async function restoreEnterpriseBackup(input: { userData: string; backupID: string }) {
  const current = await readEnterpriseStateMetadata(input.userData)
  if (!current) throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata is missing")
  const selected = current.backups.find((backup) => backup.id === input.backupID)
  if (!selected) throw new EnterpriseStateError("recovery_required", "Enterprise state backup is unavailable")
  const backup = join(input.userData, backupsName, selected.id)
  const root = join(input.userData, backupsName)
  const operation = randomUUID()
  const stage = join(root, `.restore-stage-${operation}`)
  const rollback = join(root, `.restore-rollback-${operation}`)
  await mkdir(stage, { recursive: true })
  await mkdir(rollback, { recursive: true })
  const installed: string[] = []
  try {
    for (const entry of await readdir(backup, { withFileTypes: true })) {
      if (entry.name === metadataName) continue
      await cp(join(backup, entry.name), join(stage, entry.name), {
        recursive: entry.isDirectory(),
        errorOnExist: true,
        force: false,
      })
    }
    for (const entry of await readdir(input.userData, { withFileTypes: true })) {
      if (excluded.has(entry.name.toLowerCase()) || entry.name === metadataName) continue
      await rename(join(input.userData, entry.name), join(rollback, entry.name))
    }
    for (const entry of await readdir(stage)) {
      await rename(join(stage, entry), join(input.userData, entry))
      installed.push(entry)
    }
    await writeMetadata(input.userData, {
      schemaVersion: 1,
      stateSchemaVersion,
      lastSuccessfulAppVersion: selected.appVersion,
      backups: current.backups,
    })
    await rm(rollback, { recursive: true, force: true })
    await rm(stage, { recursive: true, force: true })
  } catch {
    try {
      await Promise.all(installed.map((entry) => rm(join(input.userData, entry), { recursive: true, force: true })))
      for (const entry of await readdir(rollback)) {
        await rename(join(rollback, entry), join(input.userData, entry))
      }
      await rm(stage, { recursive: true, force: true })
      await rm(rollback, { recursive: true, force: true })
    } catch {
      throw new EnterpriseStateError("recovery_required", "Enterprise state recovery could not be completed")
    }
    throw new EnterpriseStateError("backup_failed", "Enterprise state backup could not be restored")
  }
}

export async function readEnterpriseStateMetadata(userData: string): Promise<EnterpriseStateMetadataV1 | undefined> {
  const raw = await readFile(join(userData, metadataName), "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata could not be read")
  })
  if (raw === undefined) return
  const value: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata is invalid")
    }
  })()
  if (!isMetadata(value)) throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata is invalid")
  return value
}

export async function listCompatibleEnterpriseBackups(userData: string, appVersion: string) {
  requireVersion(appVersion)
  const current = await readEnterpriseStateMetadata(userData)
  if (!current) return []
  return current.backups.filter((backup) => {
    if (backup.compatibility !== "unknown") return compareVersions(backup.appVersion, appVersion) <= 0
    return current.pendingAppVersion === appVersion && current.pendingBackupID === backup.id
  })
}

async function createBackup(userData: string, id: string) {
  const root = join(userData, backupsName)
  const temporary = join(root, `.tmp-${randomUUID()}`)
  const destination = join(root, id)
  await mkdir(temporary, { recursive: true })
  try {
    for (const entry of await readdir(userData, { withFileTypes: true })) {
      if (excluded.has(entry.name.toLowerCase())) continue
      await cp(join(userData, entry.name), join(temporary, entry.name), {
        recursive: entry.isDirectory(),
        errorOnExist: true,
        force: false,
      })
    }
    await rename(temporary, destination)
  } catch {
    await rm(temporary, { recursive: true, force: true })
    throw new EnterpriseStateError("backup_failed", "Enterprise state backup failed")
  }
}

async function writeMetadata(userData: string, metadata: EnterpriseStateMetadataV1) {
  const temporary = join(userData, `${metadataName}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, join(userData, metadataName))
  } catch {
    await rm(temporary, { force: true })
    throw new EnterpriseStateError("metadata_invalid", "Enterprise state metadata could not be written")
  }
}

function isMetadata(value: unknown): value is EnterpriseStateMetadataV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.stateSchemaVersion !== 1 ||
    !Array.isArray(value.backups)
  ) {
    return false
  }
  if (value.lastSuccessfulAppVersion !== undefined && !isVersion(value.lastSuccessfulAppVersion)) return false
  if (value.pendingAppVersion !== undefined && !isVersion(value.pendingAppVersion)) return false
  if (value.pendingBackupID !== undefined && !isBackupID(value.pendingBackupID)) return false
  const backupsValid = value.backups.every(
    (backup) =>
      isRecord(backup) &&
      isBackupID(backup.id) &&
      isVersion(backup.appVersion) &&
      typeof backup.createdAt === "string" &&
      (backup.compatibility === undefined || backup.compatibility === "unknown") &&
      !Number.isNaN(Date.parse(backup.createdAt)),
  )
  if (!backupsValid) return false
  if (value.pendingBackupID && !value.backups.some((backup) => backup.id === value.pendingBackupID)) return false
  return true
}

function compareVersions(left: string, right: string) {
  const a = requireVersion(left)
  const b = requireVersion(right)
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

function requireVersion(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) throw new EnterpriseStateError("metadata_invalid", "Enterprise application version is invalid")
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] }
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.test(value)
}

function isBackupID(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(value) && !value.includes("..")
}

function stamp(value: Date) {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
