import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createEnterpriseCredentialHandlers,
  createEnterpriseCredentialStore,
  type EnterpriseCredentials,
} from "./enterprise-credentials"
import { createEnterpriseCredentialRuntime } from "./enterprise-credential-runtime"

test("restarts the sidecar without requesting a desktop restart", async () => {
  await using fixture = await runtimeFixture()
  const observed: EnterpriseCredentials[] = []
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      observed.push(await fixture.store.all())
    },
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).resolves.toEqual({ restartRequired: false })
  await expect(runtime.clear("code")).resolves.toEqual({ restartRequired: false })
  expect(observed).toEqual([
    { schemaVersion: 2, models: { code: { apiKey: "new-key", headers: {} } } },
    { schemaVersion: 2, models: {} },
  ])
})

test("restores credentials and the prior sidecar when the changed state fails", async () => {
  await using fixture = await runtimeFixture()
  await fixture.store.setAll({
    schemaVersion: 2,
    models: { code: { apiKey: "old-key", headers: { Authorization: "old-header" } } },
  })
  const observed: EnterpriseCredentials[] = []
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      observed.push(await fixture.store.all())
      if (observed.length === 1) throw new Error("new state failed")
    },
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).rejects.toMatchObject({
    code: "restart_failed_rolled_back",
  })
  expect(await fixture.store.all()).toEqual(observed[1])
  expect(observed[1]?.models.code?.apiKey).toBe("old-key")
})

test("reports a safe recovery failure when the restored sidecar also fails", async () => {
  await using fixture = await runtimeFixture()
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      throw new Error("restart secret detail")
    },
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
    message: "restart_failed_recovery_failed",
  })
})

test("leaves the current sidecar running when credential persistence fails", async () => {
  await using fixture = await runtimeFixture()
  let restarts = 0
  const runtime = createEnterpriseCredentialRuntime({
    handlers: {
      ...fixture.handlers,
      set: async () => {
        throw new Error("persistence failed")
      },
    },
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      restarts++
    },
  })

  await expect(runtime.set({ modelID: "code", apiKey: "new-key" })).rejects.toThrow("persistence failed")
  expect(restarts).toBe(0)
  expect(await fixture.store.all()).toEqual({ schemaVersion: 2, models: {} })
})

test("serializes a later mutation behind rollback recovery", async () => {
  await using fixture = await runtimeFixture()
  await fixture.store.setAll({ schemaVersion: 2, models: { code: { apiKey: "old-key", headers: {} } } })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let restarts = 0
  const runtime = createEnterpriseCredentialRuntime({
    handlers: fixture.handlers,
    read: fixture.store.all,
    write: fixture.store.setAll,
    restart: async () => {
      restarts++
      if (restarts !== 1) return
      entered.resolve()
      await release.promise
      throw new Error("new state failed")
    },
  })
  const first = runtime.set({ modelID: "code", apiKey: "failed-key" })
  await entered.promise
  const second = runtime.set({ modelID: "reasoning", apiKey: "reasoning-key" })
  release.resolve()

  await expect(first).rejects.toMatchObject({ code: "restart_failed_rolled_back" })
  await expect(second).resolves.toEqual({ restartRequired: false })
  expect(await fixture.store.all()).toEqual({
    schemaVersion: 2,
    models: {
      code: { apiKey: "old-key", headers: {} },
      reasoning: { apiKey: "reasoning-key", headers: {} },
    },
  })
})

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "enterprise-credential-runtime-"))
  const store = createEnterpriseCredentialStore({
    file: join(root, "credentials.bin"),
    modelIDs: ["code", "reasoning"],
    defaultModelID: "code",
    encryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => value.toString("utf8"),
  })
  return {
    store,
    handlers: createEnterpriseCredentialHandlers(true, store, {
      defaultModelID: "code",
      models: [
        { id: "code", name: "Code", baseURL: "https://code.example/v1" },
        { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
      ],
    }),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}
