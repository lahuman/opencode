import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  EnterpriseStateError,
  listCompatibleEnterpriseBackups,
  markEnterpriseStateHealthy,
  prepareEnterpriseState,
  readEnterpriseStateMetadata,
  restoreEnterpriseBackup,
} from "./enterprise-state"

test("initializes pending state and records the version only after a healthy start", async () => {
  await using fixture = await stateFixture()
  expect(
    await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "2.0.0", now: fixture.now }),
  ).toEqual({ status: "pending", backupID: undefined })
  expect(await readEnterpriseStateMetadata(fixture.root)).toMatchObject({
    schemaVersion: 1,
    stateSchemaVersion: 1,
    pendingAppVersion: "2.0.0",
    backups: [],
  })

  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "2.0.0" })
  expect(await readEnterpriseStateMetadata(fixture.root)).toMatchObject({
    lastSuccessfulAppVersion: "2.0.0",
    backups: [],
  })
  expect((await readEnterpriseStateMetadata(fixture.root))?.pendingAppVersion).toBeUndefined()
})

test("creates a bootstrap backup when metadata is introduced over existing durable state", async () => {
  await using fixture = await stateFixture()
  await Bun.write(join(fixture.root, "data/opencode/opencode.db"), "legacy-database")

  const result = await prepareEnterpriseState({
    enabled: true,
    userData: fixture.root,
    appVersion: "2.0.0",
    now: fixture.now,
  })

  expect(result).toEqual({ status: "pending", backupID: "20260716T000000-bootstrap" })
  expect(
    await readFile(
      join(fixture.root, "enterprise-backups/20260716T000000-bootstrap/data/opencode/opencode.db"),
      "utf8",
    ),
  ).toBe("legacy-database")
  expect(await readEnterpriseStateMetadata(fixture.root)).toMatchObject({
    pendingAppVersion: "2.0.0",
    pendingBackupID: "20260716T000000-bootstrap",
    backups: [{ id: "20260716T000000-bootstrap", appVersion: "0.0.0" }],
  })
  expect(await listCompatibleEnterpriseBackups(fixture.root, "2.0.0")).toHaveLength(1)
  expect(await listCompatibleEnterpriseBackups(fixture.root, "3.0.0")).toEqual([])
})

test("does not treat the legacy adoption marker as durable state on a fresh install", async () => {
  await using fixture = await stateFixture()
  await Bun.write(join(fixture.root, "enterprise-legacy-adoption.json"), '{"schemaVersion":1,"adopted":[]}')

  expect(
    await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "2.0.0", now: fixture.now }),
  ).toEqual({ status: "pending", backupID: undefined })
  expect((await readEnterpriseStateMetadata(fixture.root))?.backups).toEqual([])
})

test("backs up durable AppData before a version upgrade and excludes logs and caches", async () => {
  await using fixture = await stateFixture()
  await Bun.write(join(fixture.root, "enterprise-credentials.bin"), "encrypted-credential")
  await Bun.write(join(fixture.root, "opencode.settings"), "settings")
  await Bun.write(join(fixture.root, "data/opencode/opencode.db"), "database")
  await Bun.write(join(fixture.root, "logs/run/main.log"), "prompt-secret-marker")
  await Bun.write(join(fixture.root, "cache/bin/lsp.exe"), "cache")
  await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "1.0.0", now: fixture.now })
  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "1.0.0" })

  const result = await prepareEnterpriseState({
    enabled: true,
    userData: fixture.root,
    appVersion: "2.0.0",
    now: new Date("2026-07-17T00:00:00.000Z"),
  })

  expect(result).toEqual({ status: "pending", backupID: "20260717T000000-1.0.0" })
  const backup = join(fixture.root, "enterprise-backups", result.backupID!)
  expect(await readFile(join(backup, "enterprise-credentials.bin"), "utf8")).toBe("encrypted-credential")
  expect(await readFile(join(backup, "opencode.settings"), "utf8")).toBe("settings")
  expect(await readFile(join(backup, "data/opencode/opencode.db"), "utf8")).toBe("database")
  expect(await Bun.file(join(backup, "logs/run/main.log")).exists()).toBeFalse()
  expect(await Bun.file(join(backup, "cache/bin/lsp.exe")).exists()).toBeFalse()
})

test("keeps active drafts outside version backups and restores", async () => {
  await using fixture = await stateFixture()
  await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "1.0.0", now: fixture.now })
  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "1.0.0" })
  await Bun.write(join(fixture.root, "durable.dat"), "version-1")
  await Bun.write(join(fixture.root, "drafts.sqlite"), "active-draft")
  await Bun.write(join(fixture.root, "drafts.sqlite-wal"), "active-wal")
  await Bun.write(join(fixture.root, "drafts.sqlite-shm"), "active-shm")

  const result = await prepareEnterpriseState({
    enabled: true,
    userData: fixture.root,
    appVersion: "2.0.0",
    now: new Date("2026-07-17T00:00:00.000Z"),
  })
  const backup = join(fixture.root, "enterprise-backups", result.backupID!)
  expect(await Bun.file(join(backup, "drafts.sqlite")).exists()).toBeFalse()
  expect(await Bun.file(join(backup, "drafts.sqlite-wal")).exists()).toBeFalse()
  expect(await Bun.file(join(backup, "drafts.sqlite-shm")).exists()).toBeFalse()

  await Bun.write(join(fixture.root, "durable.dat"), "partially-migrated")
  await Bun.write(join(fixture.root, "drafts.sqlite"), "latest-draft")
  await restoreEnterpriseBackup({ userData: fixture.root, backupID: result.backupID! })

  expect(await readFile(join(fixture.root, "durable.dat"), "utf8")).toBe("version-1")
  expect(await readFile(join(fixture.root, "drafts.sqlite"), "utf8")).toBe("latest-draft")
  expect(await readFile(join(fixture.root, "drafts.sqlite-wal"), "utf8")).toBe("active-wal")
  expect(await readFile(join(fixture.root, "drafts.sqlite-shm"), "utf8")).toBe("active-shm")
})

test("rejects downgrades and malformed metadata without changing durable files", async () => {
  await using fixture = await stateFixture()
  await Bun.write(join(fixture.root, "durable.dat"), "keep-me")
  await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "3.0.0", now: fixture.now })
  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "3.0.0" })

  const downgrade = await stateFailure(() =>
    prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "2.9.0", now: fixture.now }),
  )
  expect(downgrade.kind).toBe("downgrade")
  expect(await readFile(join(fixture.root, "durable.dat"), "utf8")).toBe("keep-me")

  await Bun.write(join(fixture.root, "enterprise-state.json"), "{ invalid private-path-marker")
  const invalid = await stateFailure(() =>
    prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "3.0.1", now: fixture.now }),
  )
  expect(invalid.kind).toBe("metadata_invalid")
  expect(invalid.message).not.toContain("private-path-marker")
})

test("rejects backup identifiers that could escape the backup root", async () => {
  await using fixture = await stateFixture()
  await Bun.write(
    join(fixture.root, "enterprise-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      stateSchemaVersion: 1,
      pendingAppVersion: "1.2.3",
      pendingBackupID: "../../outside",
      backups: [{ id: "../../outside", appVersion: "1.0.0", createdAt: "2026-07-16T00:00:00.000Z" }],
    }),
  )

  await expect(
    prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "1.2.3" }),
  ).rejects.toMatchObject({ kind: "metadata_invalid" })
})

test("retains only the three newest successful upgrade backups", async () => {
  await using fixture = await stateFixture()
  await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "1.0.0", now: fixture.now })
  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "1.0.0" })

  for (const [index, version] of ["2.0.0", "3.0.0", "4.0.0", "5.0.0"].entries()) {
    await prepareEnterpriseState({
      enabled: true,
      userData: fixture.root,
      appVersion: version,
      now: new Date(Date.UTC(2026, 6, 17 + index)),
    })
    await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: version })
  }

  expect((await readEnterpriseStateMetadata(fixture.root))?.backups.map((backup) => backup.appVersion)).toEqual([
    "2.0.0",
    "3.0.0",
    "4.0.0",
  ])
  expect(await Bun.file(join(fixture.root, "enterprise-backups/20260717T000000-1.0.0")).exists()).toBeFalse()
})

test("blocks a restart after an interrupted upgrade until its journaled backup is restored", async () => {
  await using fixture = await stateFixture()
  await prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "1.0.0", now: fixture.now })
  await markEnterpriseStateHealthy({ enabled: true, userData: fixture.root, appVersion: "1.0.0" })
  await Bun.write(join(fixture.root, "durable.dat"), "version-1")
  await prepareEnterpriseState({
    enabled: true,
    userData: fixture.root,
    appVersion: "2.0.0",
    now: new Date("2026-07-17T00:00:00.000Z"),
  })
  await Bun.write(join(fixture.root, "durable.dat"), "partially-migrated")

  const interrupted = await stateFailure(() =>
    prepareEnterpriseState({ enabled: true, userData: fixture.root, appVersion: "2.0.0" }),
  )
  expect(interrupted.kind).toBe("recovery_required")

  await restoreEnterpriseBackup({
    userData: fixture.root,
    backupID: "20260717T000000-1.0.0",
  })

  expect(await readFile(join(fixture.root, "durable.dat"), "utf8")).toBe("version-1")
  expect(await readEnterpriseStateMetadata(fixture.root)).toMatchObject({
    lastSuccessfulAppVersion: "1.0.0",
    backups: [{ id: "20260717T000000-1.0.0", appVersion: "1.0.0" }],
  })
  expect((await readEnterpriseStateMetadata(fixture.root))?.pendingAppVersion).toBeUndefined()
})

async function stateFixture() {
  const root = await mkdtemp(join(tmpdir(), "enterprise-state-"))
  return {
    root,
    now: new Date("2026-07-16T00:00:00.000Z"),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

async function stateFailure(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    if (error instanceof EnterpriseStateError) return error
    throw error
  }
  throw new Error("Expected enterprise state operation to fail")
}
