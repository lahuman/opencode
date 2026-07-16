import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adoptEnterpriseLegacyState } from "./enterprise-adoption"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("copies legacy data, config, and state into isolated enterprise AppData once", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-adoption-"))
  roots.push(root)
  const userData = join(root, "enterprise")
  await Bun.write(join(root, "legacy-data/opencode/opencode.db"), "sessions")
  await Bun.write(join(root, "legacy-config/opencode/opencode.json"), "settings")
  await Bun.write(join(userData, "opencode/state.json"), "state")

  const result = await adoptEnterpriseLegacyState({
    enabled: true,
    userData,
    sources: {
      data: join(root, "legacy-data"),
      config: join(root, "legacy-config"),
      state: userData,
    },
  })

  expect(result).toEqual({ adopted: ["config", "data", "state"] })
  expect(await readFile(join(userData, "data/opencode/opencode.db"), "utf8")).toBe("sessions")
  expect(await readFile(join(userData, "config/opencode/opencode.json"), "utf8")).toBe("settings")
  expect(await readFile(join(userData, "state/opencode/state.json"), "utf8")).toBe("state")

  await Bun.write(join(root, "legacy-data/opencode/new.db"), "late")
  expect(
    await adoptEnterpriseLegacyState({
      enabled: true,
      userData,
      sources: { data: join(root, "legacy-data"), config: join(root, "legacy-config"), state: userData },
    }),
  ).toEqual({ adopted: [] })
  expect(await Bun.file(join(userData, "data/opencode/new.db")).exists()).toBeFalse()
})

test("does not touch ordinary builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-adoption-"))
  roots.push(root)
  expect(
    await adoptEnterpriseLegacyState({
      enabled: false,
      userData: join(root, "enterprise"),
      sources: { data: root, config: root, state: root },
    }),
  ).toEqual({ adopted: [] })
})
