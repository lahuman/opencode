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
    [
      "analyze-codebase",
      ["analyze-codebase"],
      join(fixture.root, "skill-packs/analyze-codebase/skills"),
    ],
    [
      "debug-problems",
      ["debug-problems"],
      join(fixture.root, "skill-packs/debug-problems/skills"),
    ],
  ])
  expect(
    resolveEnterpriseSkillPackState(verified.packs, { "analyze-codebase": false, removed: true }),
  ).toEqual({
    "analyze-codebase": false,
    "debug-problems": false,
  })
})

test("rejects tampered trees, added files, missing licenses, and duplicate member names", async () => {
  await using fixture = await skillPackFixture()
  await Bun.write(
    join(fixture.root, "skill-packs/analyze-codebase/skills/analyze-codebase/SKILL.md"),
    skill("analyze-codebase", "changed"),
  )
  await expect(verifyEnterpriseSkillPacks(fixture.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using added = await skillPackFixture()
  await Bun.write(join(added.root, "skill-packs/analyze-codebase/unlisted.txt"), "extra")
  await expect(verifyEnterpriseSkillPacks(added.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using missing = await skillPackFixture()
  await rm(join(missing.root, "skill-packs/debug-problems/LICENSE"))
  await expect(verifyEnterpriseSkillPacks(missing.root)).rejects.toThrow("Enterprise skill pack verification failed")

  await using duplicate = await skillPackFixture({ debugMember: "analyze-codebase" })
  await expect(verifyEnterpriseSkillPacks(duplicate.root)).rejects.toThrow("Enterprise skill pack verification failed")
})

test("rejects a pack directory linked outside the enterprise resources", async () => {
  await using fixture = await skillPackFixture()
  await using outside = await temporaryDirectory("enterprise-skill-packs-outside-")
  const pack = join(fixture.root, "skill-packs/analyze-codebase")
  const target = join(outside.root, "analyze-codebase")
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

  await controller.setEnabled("debug-problems", true)
  expect(stored).toEqual({ "analyze-codebase": true, "debug-problems": true })
  await expect(controller.setEnabled("debug-problems", "enabled" as never)).rejects.toThrow(
    "Enterprise skill pack update is invalid",
  )
  expect(restarts).toEqual([
    [
      join(fixture.root, "skill-packs/analyze-codebase/skills"),
      join(fixture.root, "skill-packs/debug-problems/skills"),
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
  await expect(failing.setEnabled("analyze-codebase", false)).rejects.toMatchObject({
    code: "restart_failed_rolled_back",
  })
  expect(stored).toEqual({ "analyze-codebase": true, "debug-problems": true })
})

test("reports recovery failure when both the changed and restored sidecar fail", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)
  let stored = { "analyze-codebase": true, "debug-problems": false }
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

  await expect(controller.setEnabled("analyze-codebase", false)).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
  })
  expect(stored).toEqual({ "analyze-codebase": true, "debug-problems": false })
})

test("opens only the repository belonging to a verified pack ID", async () => {
  await using fixture = await skillPackFixture()
  const verified = await verifyEnterpriseSkillPacks(fixture.root)
  const opened: string[] = []

  await openEnterpriseSkillPackSource(verified.packs, "analyze-codebase", (repository) =>
    opened.push(repository),
  )
  await expect(openEnterpriseSkillPackSource(verified.packs, "unknown", () => undefined)).rejects.toThrow(
    "Enterprise skill pack is unavailable",
  )
  expect(opened).toEqual(["https://github.com/anomalyco/opencode"])
})

test("ships three focused development skills", async () => {
  const enterprise = join(import.meta.dir, "../../resources/enterprise")
  const verified = await verifyEnterpriseSkillPacks(enterprise)

  expect(verified.packs.map((pack) => ({ id: pack.id, version: pack.version, enabled: pack.defaultEnabled }))).toEqual([
    { id: "analyze-codebase", version: "1.0.1", enabled: true },
    { id: "debug-problems", version: "1.0.1", enabled: true },
    { id: "verify-changes", version: "1.0.1", enabled: true },
  ])
  expect(verified.packs.map((pack) => pack.members)).toEqual([
    ["analyze-codebase"],
    ["debug-problems"],
    ["verify-changes"],
  ])
})

test("ships intuitive English names with Korean descriptions", async () => {
  const enterprise = join(import.meta.dir, "../../resources/enterprise")
  const catalog = await Bun.file(join(enterprise, "skill-packs.json")).json()

  expect(catalog.packs.map((pack: { displayName: string; description: string }) => [pack.displayName, pack.description])).toEqual([
    ["Codebase Analysis", "기존 코드의 구조, 동작 흐름, 변경 영향 범위를 분석합니다."],
    ["Problem Debugging", "버그, 테스트 실패, 빌드 오류의 근본 원인을 체계적으로 조사합니다."],
    ["Change Verification", "변경사항을 테스트, 타입 검사, 빌드와 diff로 최종 검증합니다."],
  ])

  const descriptions = {
    "analyze-codebase":
      "기존 코드의 구조와 동작 흐름을 이해하거나 변경 대상과 영향 범위를 파악해야 할 때 사용합니다.",
    "debug-problems":
      "버그, 테스트 실패, 빌드 오류 또는 예상치 못한 동작의 근본 원인을 조사해야 할 때 사용합니다.",
    "verify-changes":
      "작업 완료를 선언하거나 커밋·PR을 만들기 전, 변경사항이 요구사항을 충족하고 검증 명령을 통과하는지 확인할 때 사용합니다.",
  }

  for (const [name, description] of Object.entries(descriptions)) {
    const file = await Array.fromAsync(
      new Bun.Glob(`skill-packs/*/skills/${name}/SKILL.md`).scan({ cwd: enterprise, absolute: true, onlyFiles: true }),
    )
    expect(file).toHaveLength(1)
    expect(await Bun.file(file[0]).text()).toContain(`name: ${name}\ndescription: ${description}\n`)
  }

  const interfaces = {
    "analyze-codebase": [
      "Codebase Analysis",
      "코드 구조와 변경 영향 범위 분석",
      "Use $analyze-codebase to analyze the current code structure and change impact.",
    ],
    "debug-problems": [
      "Problem Debugging",
      "문제의 근본 원인을 체계적으로 조사",
      "Use $debug-problems to investigate the root cause before proposing a fix.",
    ],
    "verify-changes": [
      "Change Verification",
      "변경사항을 실행 결과로 최종 검증",
      "Use $verify-changes to verify the current changes with fresh tests and checks.",
    ],
  }
  for (const [name, [displayName, shortDescription, defaultPrompt]] of Object.entries(interfaces)) {
    const content = await Bun.file(
      join(enterprise, `skill-packs/${name}/skills/${name}/agents/openai.yaml`),
    ).text()
    expect(content.replaceAll("\r\n", "\n")).toContain(
      `display_name: "${displayName}"\n  short_description: "${shortDescription}"`,
    )
    expect(content).toContain(`default_prompt: "${defaultPrompt}"`)
  }
})

test("ships skill guidance without public network acquisition paths", async () => {
  const enterprise = join(import.meta.dir, "../../resources/enterprise")
  const files = await Array.fromAsync(
    new Bun.Glob("skill-packs/{analyze-codebase,debug-problems,verify-changes}/**/*.md").scan({
      cwd: enterprise,
      absolute: true,
      onlyFiles: true,
    }),
  )

  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const content = await Bun.file(file).text()
    expect(content).not.toMatch(/https?:\/\//i)
    expect(content).not.toMatch(/\b(?:npm|pnpm|yarn|bun|pip|uv|brew)\s+install\b|\bgit\s+clone\b|\b(?:curl|wget)\b/i)
    expect(content).not.toMatch(/superpowers:|general-purpose/i)
  }
})

async function skillPackFixture(input: { debugMember?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "enterprise-skill-packs-"))
  const packs = [
    {
      id: "analyze-codebase",
      displayName: "Codebase Analysis",
      description: "Use company context.",
      version: "1.0.0",
      repository: "https://github.com/anomalyco/opencode",
      defaultEnabled: true,
      member: "analyze-codebase",
    },
    {
      id: "debug-problems",
      displayName: "Problem Debugging",
      description: "Use offline sources.",
      version: "1.0.0",
      repository: "https://github.com/anomalyco/opencode",
      defaultEnabled: false,
      member: input.debugMember ?? "debug-problems",
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
        members: [pack.member],
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
