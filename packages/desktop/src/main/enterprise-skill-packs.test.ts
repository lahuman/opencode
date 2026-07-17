import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  createEnterpriseSkillPackController,
  openEnterpriseSkillPackSource,
  resolveEnterpriseSkillPackState,
  skillPackTreeHash,
  verifyEnterpriseSkillPacks,
} from "./enterprise-skill-packs"

test("verifies deterministic pack trees and resolves persisted defaults", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)

  expect(verified.packs.map((pack) => [pack.id, pack.members, pack.root])).toEqual([
    ["ponytail", ["ponytail"], join(fixture.root, "skill-packs/ponytail/skills")],
    ["caveman", ["caveman-compress"], join(fixture.root, "skill-packs/caveman/skills")],
  ])
  expect(resolveEnterpriseSkillPackState(verified.packs, { ponytail: false, removed: true })).toEqual({
    ponytail: false,
    caveman: false,
  })
})

test("rejects tampered trees, added files, missing licenses, and duplicate member names", async () => {
  await using fixture = await skillPackFixture()
  await Bun.write(join(fixture.root, "skill-packs/ponytail/skills/ponytail/SKILL.md"), skill("ponytail", "changed"))
  await expect(verifyEnterpriseSkillPacks(fixture.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using added = await skillPackFixture()
  await Bun.write(join(added.root, "skill-packs/ponytail/unlisted.txt"), "extra")
  await expect(verifyEnterpriseSkillPacks(added.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using missing = await skillPackFixture()
  await rm(join(missing.root, "skill-packs/caveman/LICENSE"))
  await expect(verifyEnterpriseSkillPacks(missing.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using duplicate = await skillPackFixture({ cavemanMember: "ponytail" })
  await expect(verifyEnterpriseSkillPacks(duplicate.root)).rejects.toThrow("Enterprise skill pack verification failed")
})

test("rejects a pack directory linked outside the enterprise resources", async () => {
  await using fixture = await skillPackFixture()
  await using outside = await temporaryDirectory("enterprise-skill-packs-outside-")
  const pack = join(fixture.root, "skill-packs/ponytail")
  const target = join(outside.root, "ponytail")
  await rename(pack, target)
  await symlink(target, pack, process.platform === "win32" ? "junction" : "dir")

  await expect(verifyEnterpriseSkillPacks(fixture.root)).rejects.toThrow("Enterprise skill pack verification failed")
})

test("persists a toggle, restarts the sidecar, and rolls back state when restart fails", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)
  let stored: Record<string, boolean> | undefined
  const writes: Record<string, boolean>[] = []
  const restarts: string[][] = []
  const controller = createEnterpriseSkillPackController({
    packs: verified.packs,
    read: () => stored,
    write: (value) => {
      stored = value
      writes.push(value)
    },
    restart: async (paths) => {
      restarts.push(paths)
    },
  })

  await controller.setEnabled("caveman", true)
  expect(stored).toEqual({ ponytail: true, caveman: true })
  await expect(controller.setEnabled("caveman", "enabled" as never)).rejects.toThrow(
    "Enterprise skill pack update is invalid",
  )
  expect(restarts).toEqual([
    [
      join(fixture.root, "skill-packs/ponytail/skills"),
      join(fixture.root, "skill-packs/caveman/skills"),
    ],
  ])

  const failing = createEnterpriseSkillPackController({
    packs: verified.packs,
    read: () => stored,
    write: (value) => {
      stored = value
      writes.push(value)
    },
    restart: async () => {
      if (writes.length === 2) throw new Error("new state failed")
    },
  })
  await expect(failing.setEnabled("ponytail", false)).rejects.toMatchObject({
    code: "restart_failed_rolled_back",
  })
  expect(stored).toEqual({ ponytail: true, caveman: true })
})

test("reports recovery failure when both the changed and restored sidecar fail", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)
  let stored = { ponytail: true, caveman: false }
  const controller = createEnterpriseSkillPackController({
    packs: verified.packs,
    read: () => stored,
    write: (value) => {
      stored = value
    },
    restart: async () => {
      throw new Error("restart failed")
    },
  })

  await expect(controller.setEnabled("ponytail", false)).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
  })
  expect(stored).toEqual({ ponytail: true, caveman: false })
})

test("opens only the repository belonging to a verified pack ID", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)
  const opened: string[] = []

  await openEnterpriseSkillPackSource(verified.packs, "ponytail", (repository) => opened.push(repository))
  await expect(openEnterpriseSkillPackSource(verified.packs, "unknown", () => undefined)).rejects.toThrow(
    "Enterprise skill pack is unavailable",
  )
  expect(opened).toEqual(["https://github.com/DietrichGebert/ponytail"])
})

test("ships the pinned native-only enterprise pack catalog", async () => {
  const enterprise = join(import.meta.dir, "../../resources/enterprise")
  const verified = await verifyEnterpriseSkillPacks(enterprise)

  expect(
    verified.packs.map((pack) => ({ id: pack.id, version: pack.version, enabled: pack.defaultEnabled })),
  ).toEqual([
    { id: "ponytail", version: "4.8.4", enabled: true },
    { id: "caveman", version: "v1.9.1", enabled: false },
    { id: "superpowers", version: "v6.1.1", enabled: true },
  ])
  expect(verified.packs.find((pack) => pack.id === "caveman")?.members).not.toContain("caveman-stats")
  expect(verified.packs.find((pack) => pack.id === "caveman")?.members).not.toContain("cavecrew")
  expect(verified.packs.find((pack) => pack.id === "superpowers")?.members).toHaveLength(14)
})

async function skillPackFixture(input: { cavemanMember?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "enterprise-skill-packs-"))
  const packs = [
    {
      id: "ponytail",
      displayName: "Ponytail",
      description: "Prefer existing capabilities before adding code.",
      version: "4.8.4",
      repository: "https://github.com/DietrichGebert/ponytail",
      defaultEnabled: true,
      member: "ponytail",
    },
    {
      id: "caveman",
      displayName: "Caveman",
      description: "Compress instructions without losing exact tokens.",
      version: "v1.9.1",
      repository: "https://github.com/JuliusBrussee/caveman",
      defaultEnabled: false,
      member: input.cavemanMember ?? "caveman-compress",
    },
  ]
  for (const pack of packs) {
    await mkdir(join(root, `skill-packs/${pack.id}/skills/${pack.member}`), { recursive: true })
    await Bun.write(join(root, `skill-packs/${pack.id}/skills/${pack.member}/SKILL.md`), skill(pack.member))
    await Bun.write(join(root, `skill-packs/${pack.id}/LICENSE`), "MIT License\n")
  }
  const catalog = {
    schemaVersion: 1,
    packs: await Promise.all(
      packs.map(async (pack) => ({
        id: pack.id,
        displayName: pack.displayName,
        description: pack.description,
        version: pack.version,
        repository: pack.repository,
        defaultEnabled: pack.defaultEnabled,
        root: `skill-packs/${pack.id}/skills`,
        members: [pack.id === "caveman" ? "caveman-compress" : pack.member],
        license: `skill-packs/${pack.id}/LICENSE`,
        treeSHA256: await skillPackTreeHash(join(root, `skill-packs/${pack.id}`)),
      })),
    ),
  }
  await Bun.write(join(root, "skill-packs.json"), `${JSON.stringify(catalog, null, 2)}\n`)
  return {
    root,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  return {
    root,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

function skill(name: string, body = "Instructions") {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n\n# ${name}\n\n${body}\n`
}
