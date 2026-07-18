import { expect, mock, test } from "bun:test"

const updates: [string, boolean][] = []
const pack = {
  id: "caveman",
  displayName: "Caveman",
  description: "Compress instructions.",
  version: "v1.9.1",
  repository: "https://github.com/JuliusBrussee/caveman",
  root: "C:/enterprise/caveman/skills",
  members: ["caveman"],
  license: "C:/enterprise/caveman/LICENSE",
  enabled: false,
}

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}:${vars.name}` : key),
  }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    enterprise: {
      skillPacks: async () => [pack],
      setSkillPackEnabled: (id: string, enabled: boolean) => {
        updates.push([id, enabled])
        return Promise.resolve([{ ...pack, enabled }])
      },
      openSkillPackSource: async () => undefined,
    },
    openLink: () => undefined,
    openPath: async () => undefined,
  }),
}))
const { skillPackFailureKey, updateSkillPack } = await import("./skills")

test("cancels without starting an update", async () => {
  const events: string[] = []
  expect(
    await updateSkillPack({
      confirm: async () => false,
      pending: (value) => events.push(`pending:${value}`),
      update: async () => events.push("update"),
      complete: () => events.push("complete"),
      fail: () => events.push("fail"),
    }),
  ).toBe(false)
  expect(events).toEqual([])
})

test("keeps pending state around the sidecar update and applies the result", async () => {
  const events: string[] = []
  expect(
    await updateSkillPack({
      confirm: async () => true,
      pending: (value) => events.push(`pending:${value}`),
      update: async () => {
        events.push("update")
        return "enabled"
      },
      complete: (value) => events.push(`complete:${value}`),
      fail: () => events.push("fail"),
    }),
  ).toBe(true)
  expect(events).toEqual(["pending:true", "update", "complete:enabled", "pending:false"])
})

test("waits for confirmation before entering pending state or restarting the sidecar", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  const events: string[] = []
  const result = updateSkillPack({
    confirm: () => confirmation.promise,
    pending: (value) => events.push(`pending:${value}`),
    update: async () => {
      events.push("update")
      return "enabled"
    },
    complete: (value) => events.push(`complete:${value}`),
    fail: () => events.push("fail"),
  })

  await Promise.resolve()
  expect(events).toEqual([])

  confirmation.resolve(true)
  expect(await result).toBe(true)
  expect(events).toEqual(["pending:true", "update", "complete:enabled", "pending:false"])
})

test("maps rollback outcomes to actionable skill setting messages", () => {
  expect(skillPackFailureKey(new Error("restart_failed_rolled_back"))).toBe("settings.skills.error.rolledBack")
  expect(skillPackFailureKey(new Error("restart_failed_recovery_failed"))).toBe(
    "settings.skills.error.recoveryFailed",
  )
  expect(skillPackFailureKey(new Error("unexpected"))).toBe("settings.skills.error.generic")
})
