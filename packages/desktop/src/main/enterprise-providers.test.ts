import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEnterpriseProviderStore, validateEnterpriseProviderCatalog } from "./enterprise-providers"

test("rejects invalid URLs and dangling defaults", () => {
  expect(() =>
    validateEnterpriseProviderCatalog({
      schemaVersion: 1,
      default: { providerID: "missing", modelID: "model" },
      providers: [
        {
          id: "provider",
          name: "Provider",
          baseURL: "https://user:pass@example.com/v1",
          models: [],
        },
      ],
    }),
  ).toThrow()
})

test("seeds one provider per packaged legacy model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const store = createEnterpriseProviderStore({ file: join(dir, "providers.json") })
    const initialized = await store.initialize(
      {
        defaultModelID: "code",
        models: [
          { id: "code", name: "Code", baseURL: "https://code.example/v1" },
          { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
        ],
      },
      {
        schemaVersion: 2,
        models: {
          code: { apiKey: "code-key", headers: {} },
          reasoning: { headers: { "X-Token": "reasoning-token" } },
        },
      },
    )

    expect(initialized.catalog).toEqual({
      schemaVersion: 1,
      default: { providerID: "company-llm", modelID: "code" },
      providers: [
        { id: "company-llm", name: "Code", baseURL: "https://code.example/v1", models: [{ id: "code", name: "Code" }] },
        {
          id: "company-llm-2",
          name: "Reasoning",
          baseURL: "https://reasoning.example/v1",
          models: [{ id: "reasoning", name: "Reasoning" }],
        },
      ],
    })
    expect(initialized.credentials).toEqual({
      schemaVersion: 3,
      providers: {
        "company-llm": { apiKey: "code-key", headers: {} },
        "company-llm-2": { headers: { "X-Token": "reasoning-token" } },
      },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("assigns company-llm to a non-first legacy default without changing model identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const initialized = await createEnterpriseProviderStore({ file: join(dir, "providers.json") }).initialize(
      {
        defaultModelID: "reasoning",
        models: [
          { id: "code", name: "Code", baseURL: "https://code.example/v1" },
          { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
          { id: "history", name: "Historical", baseURL: "https://history.example/v1" },
        ],
      },
      {
        schemaVersion: 2,
        models: {
          code: { apiKey: "code-key", headers: {} },
          reasoning: { apiKey: "reasoning-key", headers: {} },
          history: { headers: { "X-History": "history-secret" } },
        },
      },
    )

    expect(initialized.catalog).toEqual({
      schemaVersion: 1,
      default: { providerID: "company-llm", modelID: "reasoning" },
      providers: [
        { id: "company-llm-2", name: "Code", baseURL: "https://code.example/v1", models: [{ id: "code", name: "Code" }] },
        {
          id: "company-llm",
          name: "Reasoning",
          baseURL: "https://reasoning.example/v1",
          models: [{ id: "reasoning", name: "Reasoning" }],
        },
        {
          id: "company-llm-3",
          name: "Historical",
          baseURL: "https://history.example/v1",
          models: [{ id: "history", name: "Historical" }],
        },
      ],
    })
    expect(initialized.credentials).toEqual({
      schemaVersion: 3,
      providers: {
        "company-llm-2": { apiKey: "code-key", headers: {} },
        "company-llm": { apiKey: "reasoning-key", headers: {} },
        "company-llm-3": { headers: { "X-History": "history-secret" } },
      },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("re-derives provider credentials when catalog initialization is retried after a legacy migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const store = createEnterpriseProviderStore({ file: join(dir, "providers.json") })
    const profile = {
      defaultModelID: "code",
      models: [
        { id: "code", name: "Code", baseURL: "https://code.example/v1" },
        { id: "reasoning", name: "Reasoning", baseURL: "https://reasoning.example/v1" },
      ],
    }
    const legacy = {
      schemaVersion: 2 as const,
      models: {
        code: { apiKey: "code-key", headers: {} },
        reasoning: { headers: { "X-Token": "reasoning-token" } },
      },
    }

    await store.initialize(profile, legacy)

    expect(await store.initialize(profile, legacy)).toEqual({
      catalog: await store.read(),
      credentials: {
        schemaVersion: 3,
        providers: {
          "company-llm": { apiKey: "code-key", headers: {} },
          "company-llm-2": { headers: { "X-Token": "reasoning-token" } },
        },
      },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects duplicate IDs and incomplete provider metadata", () => {
  const invalid = [
    {
      schemaVersion: 1,
      providers: [
        { id: "provider", name: "Provider", baseURL: "https://provider.example/v1", models: [] },
        { id: "provider", name: "Duplicate", baseURL: "https://duplicate.example/v1", models: [] },
      ],
    },
    {
      schemaVersion: 1,
      providers: [
        {
          id: "provider",
          name: "",
          baseURL: "https://provider.example/v1",
          models: [
            { id: "model", name: "Model" },
            { id: "model", name: "Duplicate" },
          ],
        },
      ],
    },
    {
      schemaVersion: 1,
      providers: [{ id: "provider", name: "Provider", baseURL: "https://provider.example/v1#fragment", models: [] }],
    },
  ]

  invalid.forEach((catalog) => expect(() => validateEnterpriseProviderCatalog(catalog)).toThrow())
})

test("rejects query parameters in provider URLs", () => {
  expect(() =>
    validateEnterpriseProviderCatalog({
      schemaVersion: 1,
      providers: [{ id: "provider", name: "Provider", baseURL: "https://provider.example/v1?query=value", models: [] }],
    }),
  ).toThrow()
})

test("allows empty catalogs and normalizes provider URLs", () => {
  expect(
    validateEnterpriseProviderCatalog({
      schemaVersion: 1,
      providers: [{ id: "provider", name: "Provider", baseURL: "https://provider.example/v1", models: [] }],
    }),
  ).toEqual({
    schemaVersion: 1,
    providers: [{ id: "provider", name: "Provider", baseURL: "https://provider.example/v1", models: [] }],
  })
  expect(validateEnterpriseProviderCatalog({ schemaVersion: 1, providers: [] })).toEqual({ schemaVersion: 1, providers: [] })
})

test("seeds an empty catalog for a new user with no packaged models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const store = createEnterpriseProviderStore({ file: join(dir, "providers.json") })

    const result = await store.initialize({ models: [], defaultModelID: "" })

    expect(result.catalog).toEqual({ schemaVersion: 1, providers: [] })
    expect(await store.read()).toEqual(result.catalog)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("preserves an existing user catalog when packaged models are empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const store = createEnterpriseProviderStore({ file: join(dir, "providers.json") })
    const existing = {
      schemaVersion: 1 as const,
      default: { providerID: "existing", modelID: "model" },
      providers: [
        {
          id: "existing",
          name: "Existing",
          baseURL: "https://existing.example/v1",
          models: [{ id: "model", name: "Model" }],
        },
      ],
    }
    await store.write(existing)

    expect((await store.initialize({ models: [], defaultModelID: "" })).catalog).toEqual(existing)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("preserves an existing catalog and cleans up temp files after failed writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const file = join(dir, "providers.json")
    const store = createEnterpriseProviderStore({ file })
    const catalog = {
      schemaVersion: 1 as const,
      default: { providerID: "existing", modelID: "model" },
      providers: [
        {
          id: "existing",
          name: "Existing",
          baseURL: "https://existing.example/v1",
          models: [{ id: "model", name: "Model" }],
        },
      ],
    }
    await store.write(catalog)

    expect(
      await store.initialize(
        { defaultModelID: "new", models: [{ id: "new", name: "New", baseURL: "https://new.example/v1" }] },
      ),
    ).toEqual({ catalog })
    expect(await store.read()).toEqual(catalog)

    await rm(file)
    await mkdir(file)
    await expect(store.write(catalog)).rejects.toThrow()
    expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
    await rm(file, { recursive: true })
    await writeFile(file, "{ invalid json")
    await expect(store.read()).rejects.toThrow("catalog is invalid")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("uses stable provider ID suffixes during migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "enterprise-providers-"))
  try {
    const initialized = await createEnterpriseProviderStore({ file: join(dir, "providers.json") }).initialize(
      {
        defaultModelID: "first",
        models: [
          { id: "first", name: "First", baseURL: "https://first.example/v1" },
          { id: "second", name: "Second", baseURL: "https://second.example/v1" },
          { id: "third", name: "Third", baseURL: "https://third.example/v1" },
        ],
      },
      { schemaVersion: 2, models: {} },
    )

    expect(initialized.catalog.providers.map((provider) => provider.id)).toEqual([
      "company-llm",
      "company-llm-2",
      "company-llm-3",
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
