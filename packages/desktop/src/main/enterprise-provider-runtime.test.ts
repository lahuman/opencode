import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEnterpriseCredentialStore, type EnterpriseProviderCredentials } from "./enterprise-credentials"
import {
  createEnterpriseProviderRuntime,
  createEnterpriseSidecarTransitionQueue,
  initializeEnterpriseProviderStores,
} from "./enterprise-provider-runtime"
import { createEnterpriseProviderStore, type EnterpriseProviderCatalog } from "./enterprise-providers"

type TestState = { catalog: EnterpriseProviderCatalog; credentials: EnterpriseProviderCredentials }
type TestRestart = (catalog: EnterpriseProviderCatalog, credentials: EnterpriseProviderCredentials) => Promise<void>

const initial = (): TestState => ({
  catalog: {
    schemaVersion: 1,
    default: { providerID: "provider", modelID: "model" },
    providers: [
      {
        id: "provider",
        name: "Provider",
        baseURL: "https://provider.example/v1",
        models: [{ id: "model", name: "Model" }],
      },
    ],
  },
  credentials: {
    schemaVersion: 3,
    providers: { provider: { apiKey: "secret", headers: { Authorization: "header-secret" } } },
  },
})

test("creates, updates, and deletes providers while keeping provider IDs immutable", async () => {
  const runtime = createRuntime(initial())

  await runtime.createProvider({
    provider: {
      id: "second",
      name: "Second",
      baseURL: "https://second.example/v1",
      models: [],
    },
  })
  await runtime.updateProvider({
    providerID: "second",
    name: "Updated",
    baseURL: "https://updated.example/v1",
  })

  expect(runtime.readCatalog().providers[1]).toEqual({
    id: "second",
    name: "Updated",
    baseURL: "https://updated.example/v1",
    models: [],
  })
  await expect(
    runtime.updateProvider({ providerID: "missing", name: "Renamed", baseURL: "https://renamed.example/v1" }),
  ).rejects.toThrow("provider")
  await runtime.deleteProvider("second")
  expect(runtime.readCatalog().providers.map((provider) => provider.id)).toEqual(["provider"])
})

test("creates, updates, and deletes models while keeping model IDs immutable", async () => {
  const runtime = createRuntime(initial())

  await runtime.createModel({ providerID: "provider", model: { id: "reasoning", name: "Reasoning" } })
  await runtime.updateModel({ providerID: "provider", modelID: "reasoning", name: "Updated reasoning" })

  expect(runtime.readCatalog().providers[0]?.models).toEqual([
    { id: "model", name: "Model" },
    { id: "reasoning", name: "Updated reasoning" },
  ])
  await expect(
    runtime.updateModel({ providerID: "provider", modelID: "missing", name: "Renamed" }),
  ).rejects.toThrow("model")
  await runtime.deleteModel({ providerID: "provider", modelID: "reasoning" })
  expect(runtime.readCatalog().providers[0]?.models).toEqual([{ id: "model", name: "Model" }])
})

test("allows a provider with zero models and selects the first subsequently created model", async () => {
  const runtime = createRuntime({ catalog: { schemaVersion: 1, providers: [] }, credentials: { schemaVersion: 3, providers: {} } })

  await runtime.createProvider({
    provider: { id: "empty", name: "Empty", baseURL: "https://empty.example/v1", models: [] },
  })
  expect(runtime.readCatalog().default).toBeUndefined()

  await runtime.createModel({ providerID: "empty", model: { id: "first", name: "First" } })
  expect(runtime.readCatalog().default).toEqual({ providerID: "empty", modelID: "first" })
})

test("deleting the default chooses the same provider's first remaining model", async () => {
  const runtime = createRuntime({
    catalog: {
      schemaVersion: 1,
      default: { providerID: "provider", modelID: "second" },
      providers: [
        {
          id: "provider",
          name: "Provider",
          baseURL: "https://provider.example/v1",
          models: [
            { id: "first", name: "First" },
            { id: "second", name: "Second" },
          ],
        },
      ],
    },
    credentials: { schemaVersion: 3, providers: { provider: { headers: {} } } },
  })

  const result = await runtime.deleteModel({ providerID: "provider", modelID: "second" })

  expect(result.default).toEqual({ providerID: "provider", modelID: "first" })
})

test("default fallback uses the first model of the first remaining provider", async () => {
  const state = initial()
  state.catalog.providers.push(
    {
      id: "empty",
      name: "Empty",
      baseURL: "https://empty.example/v1",
      models: [],
    },
    {
      id: "fallback",
      name: "Fallback",
      baseURL: "https://fallback.example/v1",
      models: [{ id: "first", name: "First" }],
    },
  )
  const runtime = createRuntime(state)

  const result = await runtime.deleteProvider("provider")

  expect(result.default).toEqual({ providerID: "fallback", modelID: "first" })
})

test("sets only an existing model as the default", async () => {
  const runtime = createRuntime(initial())

  await expect(runtime.setDefaultModel({ providerID: "provider", modelID: "missing" })).rejects.toThrow("model")
  expect(await runtime.setDefaultModel({ providerID: "provider", modelID: "model" })).toMatchObject({
    default: { providerID: "provider", modelID: "model" },
  })
})

test("restart failure restores both stores", async () => {
  const state = initial()
  let restarts = 0
  const runtime = createRuntime(state, {
    restart: async () => {
      restarts++
      if (restarts === 1) throw new Error("restart failed")
    },
  })

  await expect(runtime.deleteProvider("provider")).rejects.toThrow("restart_failed_rolled_back")
  expect(runtime.readCatalog()).toEqual(state.catalog)
  expect(runtime.readCredentials()).toEqual(state.credentials)
})

test("credential persistence failure restores both stores without restarting", async () => {
  const state = initial()
  let credentialWrites = 0
  let restarts = 0
  const runtime = createRuntime(state, {
    writeCredentials: async (value, write) => {
      credentialWrites++
      if (credentialWrites === 1) throw new Error("credential write failed")
      write(value)
    },
    restart: async () => {
      restarts++
    },
  })

  await expect(runtime.deleteProvider("provider")).rejects.toThrow("credential write failed")
  expect(runtime.readCatalog()).toEqual(state.catalog)
  expect(runtime.readCredentials()).toEqual(state.credentials)
  expect(restarts).toBe(0)
})

test("persistence recovery failure reports only the stable recovery error", async () => {
  let catalogWrites = 0
  const runtime = createRuntime(initial(), {
    writeCatalog: async (value, write) => {
      catalogWrites++
      if (catalogWrites === 2) throw new Error("recovery catalog secret detail")
      write(value)
    },
    writeCredentials: async () => {
      throw new Error("candidate credential secret detail")
    },
  })

  const error = await runtime.deleteProvider("provider").catch((failure: unknown) => failure)

  expect(error).toMatchObject({
    code: "restart_failed_recovery_failed",
    message: "restart_failed_recovery_failed",
  })
  expect(String(error)).not.toContain("secret detail")
})

test("a failed restart and failed recovery reports the explicit recovery error", async () => {
  const runtime = createRuntime(initial(), {
    restart: async () => {
      throw new Error("restart failed")
    },
  })

  await expect(runtime.deleteProvider("provider")).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
    message: "restart_failed_recovery_failed",
  })
})

test("queues a second mutation until the first restart completes", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const restarts: string[][] = []
  const runtime = createRuntime(initial(), {
    restart: async (catalog) => {
      restarts.push(catalog.providers.map((provider) => provider.id))
      if (restarts.length !== 1) return
      entered.resolve()
      await release.promise
    },
  })

  const first = runtime.createProvider({
    provider: { id: "second", name: "Second", baseURL: "https://second.example/v1", models: [] },
  })
  await entered.promise
  const second = runtime.deleteProvider("provider")
  await Promise.resolve()
  expect(restarts).toHaveLength(1)
  release.resolve()
  await Promise.all([first, second])

  expect(restarts).toEqual([["provider", "second"], ["second"]])
})

test("serializes shared sidecar transitions and continues after rejection", async () => {
  const enqueue = createEnterpriseSidecarTransitionQueue()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const first = enqueue(async () => {
    events.push("first:start")
    entered.resolve()
    await release.promise
    events.push("first:fail")
    throw new Error("transition failed")
  })
  await entered.promise
  const second = enqueue(async () => {
    events.push("second:start")
    return "second:done"
  })

  await Promise.resolve()
  expect(events).toEqual(["first:start"])
  release.resolve()
  await expect(first).rejects.toThrow("transition failed")
  await expect(second).resolves.toBe("second:done")
  expect(events).toEqual(["first:start", "first:fail", "second:start"])
})

test("provider credentials are replaced, cleared, and removed without exposing values", async () => {
  const runtime = createRuntime(initial())

  const replaced = await runtime.replaceProviderCredentials({
    providerID: "provider",
    credentials: { headers: { "X-Token": "replacement-secret", "X-Region": "west" } },
  })
  expect(runtime.readCredentials().providers.provider).toEqual({
    headers: { "X-Token": "replacement-secret", "X-Region": "west" },
  })
  expect(replaced.providers[0]?.credentials).toEqual({
    configured: true,
    headerNames: ["X-Token", "X-Region"],
  })
  expect(JSON.stringify(replaced)).not.toContain("replacement-secret")

  await runtime.clearProviderCredentials("provider")
  expect(runtime.readCredentials().providers.provider).toEqual({ headers: {} })
  await runtime.deleteProvider("provider")
  expect(runtime.readCredentials().providers.provider).toBeUndefined()
})

test("updates provider metadata and clears credentials in one restart", async () => {
  const restarts: TestState[] = []
  const runtime = createRuntime(initial(), {
    restart: async (catalog, credentials) => {
      restarts.push({ catalog, credentials })
    },
  })

  await runtime.updateProvider({
    providerID: "provider",
    name: "Updated",
    baseURL: "https://updated.example/v1",
    clearCredentials: true,
  })

  expect(runtime.readCatalog().providers[0]).toMatchObject({
    id: "provider",
    name: "Updated",
    baseURL: "https://updated.example/v1",
  })
  expect(runtime.readCredentials().providers.provider).toEqual({ headers: {} })
  expect(restarts).toEqual([{ catalog: runtime.readCatalog(), credentials: runtime.readCredentials() }])
})

test("normalizes provider credential secrets and header names in main", async () => {
  const runtime = createRuntime(initial())

  await runtime.replaceProviderCredentials({
    providerID: "provider",
    credentials: { apiKey: "  replacement-secret  ", headers: { "  X-Token  ": "  header-secret  " } },
  })

  expect(runtime.readCredentials().providers.provider).toEqual({
    apiKey: "replacement-secret",
    headers: { "X-Token": "header-secret" },
  })
})

test("rejects blank or case-insensitively duplicated credential headers in main", async () => {
  const runtime = createRuntime(initial())
  const invalid = [
    { headers: { "   ": "secret" } },
    { headers: { "X-Token": "   " } },
    { headers: { "X-Token": "first", "x-token": "second" } },
  ]

  for (const credentials of invalid) {
    await expect(runtime.replaceProviderCredentials({ providerID: "provider", credentials })).rejects.toThrow(
      "credentials are invalid",
    )
  }
  expect(runtime.readCredentials()).toEqual(initial().credentials)
})

test("credential health errors are redacted into every provider view", async () => {
  const runtime = createRuntime(initial(), { health: async () => ({ state: "corrupt" as const }) })

  const view = await runtime.providerCatalog()

  expect(view.providers[0]?.credentials).toEqual({
    configured: false,
    headerNames: [],
    errorCode: "credential_decryption_failed",
  })
  expect(JSON.stringify(view)).not.toContain("secret")
})

test("catalog snapshots reject credentials for providers outside the catalog", async () => {
  const state = initial()
  state.credentials.providers.orphan = { apiKey: "orphan-secret", headers: {} }
  const runtime = createRuntime(state)

  await expect(runtime.providerCatalog()).rejects.toMatchObject({
    code: "credential_provider_not_configured",
    message: "credential_provider_not_configured",
  })
})

;(["corrupt", "encryption-unavailable"] as const).forEach((healthState) => {
  test(`credential ${healthState} blocks mutations before reads or writes`, async () => {
    const state = initial()
    let catalogWrites = 0
    let credentialReads = 0
    let credentialWrites = 0
    let restarts = 0
    const runtime = createRuntime(state, {
      health: async () => ({ state: healthState }),
      readCredentials: () => {
        credentialReads++
      },
      writeCatalog: async (value, write) => {
        catalogWrites++
        write(value)
      },
      writeCredentials: async (value, write) => {
        credentialWrites++
        write(value)
      },
      restart: async () => {
        restarts++
      },
    })
    const errorCode =
      healthState === "corrupt" ? "credential_decryption_failed" : "credential_encryption_unavailable"

    await expect(
      runtime.updateProvider({
        providerID: "provider",
        name: "Updated",
        baseURL: "https://updated.example/v1",
      }),
    ).rejects.toMatchObject({ code: errorCode, message: errorCode })
    const view = await runtime.providerCatalog()

    expect(view.providers[0]?.credentials).toEqual({ configured: false, headerNames: [], errorCode })
    expect(runtime.readCatalog()).toEqual(state.catalog)
    expect(runtime.readCredentials()).toEqual(state.credentials)
    expect({ catalogWrites, credentialReads, credentialWrites, restarts }).toEqual({
      catalogWrites: 0,
      credentialReads: 0,
      credentialWrites: 0,
      restarts: 0,
    })
  })
})

test("startup migration writes schema v3 once and is retry-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-provider-startup-"))
  try {
    const file = join(root, "credentials.bin")
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 2, models: { code: { apiKey: "legacy-secret", headers: {} } } }),
    )
    let writes = 0
    const credentials = createEnterpriseCredentialStore({
      file,
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
      write: async (path, value) => {
        writes++
        await writeFile(path, value)
      },
    })
    const catalog = createEnterpriseProviderStore({ file: join(root, "providers.json") })
    const profile = {
      defaultModelID: "code",
      models: [{ id: "code", name: "Code", baseURL: "https://code.example/v1" }],
    }

    await initializeEnterpriseProviderStores({ catalog, credentials, profile })
    const migratedWrites = writes
    await initializeEnterpriseProviderStores({ catalog, credentials, profile })

    expect(await credentials.read()).toEqual({
      schemaVersion: 3,
      providers: { "company-llm": { apiKey: "legacy-secret", headers: {} } },
    })
    expect(writes).toBe(migratedWrites)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("startup rejects orphaned provider credentials without modifying durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "enterprise-provider-orphan-"))
  try {
    const catalog = createEnterpriseProviderStore({ file: join(root, "providers.json") })
    await catalog.write(initial().catalog)
    const credentials = createEnterpriseCredentialStore({
      file: join(root, "credentials.bin"),
      encryptionAvailable: () => true,
      encrypt: Buffer.from,
      decrypt: (value) => value.toString("utf8"),
    })
    await credentials.write({
      schemaVersion: 3,
      providers: {
        provider: { apiKey: "provider-secret", headers: {} },
        orphan: { apiKey: "orphan-secret", headers: {} },
      },
    })
    const before = await readFile(join(root, "credentials.bin"))

    await expect(
      initializeEnterpriseProviderStores({
        catalog,
        credentials,
        profile: {
          defaultModelID: "model",
          models: [{ id: "model", name: "Model", baseURL: "https://provider.example/v1" }],
        },
      }),
    ).rejects.toMatchObject({
      code: "credential_provider_not_configured",
      message: "credential_provider_not_configured",
    })
    expect(await readFile(join(root, "credentials.bin"))).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

;(["corrupt", "encryption-unavailable"] as const).forEach((healthState) => {
  test(`startup preserves ${healthState} credentials without initializing either store`, async () => {
    const root = await mkdtemp(join(tmpdir(), "enterprise-provider-unreadable-"))
    try {
      const credentialFile = join(root, "credentials.bin")
      const catalogFile = join(root, "providers.json")
      const catalog = createEnterpriseProviderStore({ file: catalogFile })
      await catalog.write(initial().catalog)
      await writeFile(
        credentialFile,
        healthState === "corrupt"
          ? "unreadable-encrypted-secret"
          : JSON.stringify({ schemaVersion: 3, providers: { provider: { apiKey: "secret", headers: {} } } }),
      )
      const beforeCatalog = await readFile(catalogFile)
      const beforeCredentials = await readFile(credentialFile)
      const credentials = createEnterpriseCredentialStore({
        file: credentialFile,
        encryptionAvailable: () => healthState !== "encryption-unavailable",
        encrypt: Buffer.from,
        decrypt: (value) => {
          if (healthState === "corrupt") throw new Error("decrypt secret detail")
          return value.toString("utf8")
        },
      })
      const errorCode =
        healthState === "corrupt" ? "credential_decryption_failed" : "credential_encryption_unavailable"

      await expect(
        initializeEnterpriseProviderStores({
          catalog,
          credentials,
          profile: {
            defaultModelID: "code",
            models: [{ id: "code", name: "Code", baseURL: "https://code.example/v1" }],
          },
        }),
      ).rejects.toMatchObject({ code: errorCode, message: errorCode })
      expect(await readFile(catalogFile)).toEqual(beforeCatalog)
      expect(await readFile(credentialFile)).toEqual(beforeCredentials)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function createRuntime(
  state: TestState,
  overrides: {
    restart?: TestRestart
    health?: () => Promise<
      { state: "available" | "missing" } | { state: "corrupt" | "encryption-unavailable" }
    >
    writeCatalog?: (
      value: EnterpriseProviderCatalog,
      write: (value: EnterpriseProviderCatalog) => void,
    ) => Promise<void>
    writeCredentials?: (
      value: EnterpriseProviderCredentials,
      write: (value: EnterpriseProviderCredentials) => void,
    ) => Promise<void>
    readCredentials?: () => void
  } = {},
) {
  let catalog = structuredClone(state.catalog)
  let credentials = structuredClone(state.credentials)
  return Object.assign(
    createEnterpriseProviderRuntime({
      catalog: {
        read: async () => structuredClone(catalog),
        write: async (value) => {
          const write = (next: EnterpriseProviderCatalog) => {
            catalog = structuredClone(next)
          }
          if (overrides.writeCatalog) return overrides.writeCatalog(value, write)
          write(value)
        },
      },
      credentials: {
        read: async () => {
          overrides.readCredentials?.()
          return structuredClone(credentials)
        },
        write: async (value) => {
          const write = (next: EnterpriseProviderCredentials) => {
            credentials = structuredClone(next)
          }
          if (overrides.writeCredentials) return overrides.writeCredentials(value, write)
          write(value)
        },
        health: overrides.health ?? (async () => ({ state: "available" as const })),
      },
      restart: overrides.restart ?? (async () => undefined),
    }),
    {
      readCatalog: () => structuredClone(catalog),
      readCredentials: () => structuredClone(credentials),
    },
  )
}
