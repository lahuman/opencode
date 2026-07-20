import { expect, test } from "bun:test"
import { createEnterpriseAPI, mapEnterpriseAPI } from "./types"

test("the preload entrypoint exposes the concrete API with enterprise guide wiring", async () => {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/../../test/preload-entrypoint.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe(
    JSON.stringify({
      key: "api",
      guide: { version: "2026.08", markdown: "# Concrete guide" },
      invocations: [
        { channel: "enterprise-guide-read", args: [] },
        { channel: "relaunch", args: [] },
      ],
    }),
  )
})

test("maps enterprise guide reads to the main IPC channel", async () => {
  const invocations: { channel: string; args: unknown[] }[] = []
  const enterprise = createEnterpriseAPI(true, (channel, ...args) => {
    invocations.push({ channel, args })
    return Promise.resolve({ version: "2026.07", markdown: "# Company guide" })
  })

  await expect(enterprise.readGuide()).resolves.toEqual({ version: "2026.07", markdown: "# Company guide" })
  expect(invocations).toEqual([{ channel: "enterprise-guide-read", args: [] }])
})

test("maps provider diagnostics to the enterprise readiness IPC channel", async () => {
  const invocations: { channel: string; args: unknown[] }[] = []
  const enterprise = createEnterpriseAPI(true, (channel, ...args) => {
    invocations.push({ channel, args })
    return Promise.resolve({ schemaVersion: 1, overall: "pass", generatedAt: "now", checks: [] })
  })
  const diagnostic = {
    ok: true,
    checks: { basic: "pass" as const, streaming: "pass" as const, toolCall: "pass" as const },
  }

  await enterprise.readiness(diagnostic)

  expect(invocations).toEqual([{ channel: "enterprise-readiness", args: [diagnostic] }])
})

test("preserves provider recovery error codes across the IPC boundary", async () => {
  const enterprise = createEnterpriseAPI(true, () =>
    Promise.reject(new Error("Error invoking remote method: Error: restart_failed_recovery_failed")),
  )

  await expect(
    enterprise.updateProvider({
      providerID: "provider",
      name: "Updated",
      baseURL: "https://updated.example/v1",
    }),
  ).rejects.toMatchObject({
    code: "restart_failed_recovery_failed",
    message: "restart_failed_recovery_failed",
  })
})

test("maps provider management operations to explicit private IPC channels", async () => {
  const invocations: { channel: string; args: unknown[] }[] = []
  const enterprise = createEnterpriseAPI(true, (channel, ...args) => {
    invocations.push({ channel, args })
    return Promise.resolve({ schemaVersion: 1, providers: [] })
  })
  const provider = {
    id: "provider",
    name: "Provider",
    baseURL: "https://provider.example/v1",
    models: [{ id: "model", name: "Model" }],
  }
  const credentials = { apiKey: "secret", headers: { Authorization: "header-secret" } }

  await enterprise.providerCatalog()
  await enterprise.createProvider({ provider, credentials })
  await enterprise.updateProvider({
    providerID: "provider",
    name: "Updated",
    baseURL: "https://updated.example/v1",
    credentials,
  })
  await enterprise.updateProvider({
    providerID: "provider",
    name: "Cleared",
    baseURL: "https://cleared.example/v1",
    clearCredentials: true,
  })
  await enterprise.deleteProvider("provider")
  await enterprise.createModel({ providerID: "provider", model: { id: "second", name: "Second" } })
  await enterprise.updateModel({ providerID: "provider", modelID: "second", name: "Updated second" })
  await enterprise.deleteModel({ providerID: "provider", modelID: "second" })
  await enterprise.setDefaultModel({ providerID: "provider", modelID: "model" })
  await enterprise.replaceProviderCredentials({ providerID: "provider", credentials })
  await enterprise.clearProviderCredentials("provider")

  expect(invocations).toEqual([
    { channel: "enterprise-provider-catalog", args: [] },
    { channel: "enterprise-provider-create", args: [{ provider, credentials }] },
    {
      channel: "enterprise-provider-update",
      args: [
        {
          providerID: "provider",
          name: "Updated",
          baseURL: "https://updated.example/v1",
          credentials,
        },
      ],
    },
    {
      channel: "enterprise-provider-update",
      args: [
        {
          providerID: "provider",
          name: "Cleared",
          baseURL: "https://cleared.example/v1",
          clearCredentials: true,
        },
      ],
    },
    { channel: "enterprise-provider-delete", args: ["provider"] },
    {
      channel: "enterprise-model-create",
      args: [{ providerID: "provider", model: { id: "second", name: "Second" } }],
    },
    {
      channel: "enterprise-model-update",
      args: [{ providerID: "provider", modelID: "second", name: "Updated second" }],
    },
    { channel: "enterprise-model-delete", args: [{ providerID: "provider", modelID: "second" }] },
    { channel: "enterprise-model-default", args: [{ providerID: "provider", modelID: "model" }] },
    { channel: "enterprise-provider-credentials-replace", args: [{ providerID: "provider", credentials }] },
    { channel: "enterprise-provider-credentials-clear", args: ["provider"] },
  ])
})

test("maps skill pack reads and updates to private enterprise IPC channels", async () => {
  const invocations: { channel: string; args: unknown[] }[] = []
  const enterprise = createEnterpriseAPI(true, (channel, ...args) => {
    invocations.push({ channel, args })
    return Promise.resolve([])
  })

  await enterprise.skillPacks()
  await enterprise.setSkillPackEnabled("verify-changes", true)
  await enterprise.openSkillPackSource("verify-changes")

  expect(invocations).toEqual([
    { channel: "enterprise-skill-packs", args: [] },
    { channel: "enterprise-skill-pack-set", args: ["verify-changes", true] },
    { channel: "enterprise-skill-pack-source", args: ["verify-changes"] },
  ])
})

test("maps the preload enterprise API to the app platform contract", () => {
  const enterprise = {
    enabled: true,
    providerCatalog: async () => ({ schemaVersion: 1 as const, providers: [] }),
    createProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    updateProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    deleteProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    createModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    updateModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    deleteModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    setDefaultModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    replaceProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
    clearProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
    readGuide: async () => ({ version: "2026.07", markdown: "# Company guide" }),
    readiness: async () => ({ schemaVersion: 1 as const, generatedAt: "now", overall: "pass" as const, checks: [] }),
    stateBackups: async () => [],
    restoreStateBackup: async () => ({ restartRequired: true as const }),
    skillPacks: async () => [],
    setSkillPackEnabled: async () => [],
    openSkillPackSource: async () => undefined,
  }

  const platform = mapEnterpriseAPI(enterprise)

  expect(platform).toEqual({
    providerCatalog: enterprise.providerCatalog,
    createProvider: enterprise.createProvider,
    updateProvider: enterprise.updateProvider,
    deleteProvider: enterprise.deleteProvider,
    createModel: enterprise.createModel,
    updateModel: enterprise.updateModel,
    deleteModel: enterprise.deleteModel,
    setDefaultModel: enterprise.setDefaultModel,
    replaceProviderCredentials: enterprise.replaceProviderCredentials,
    clearProviderCredentials: enterprise.clearProviderCredentials,
    readGuide: enterprise.readGuide,
    readiness: enterprise.readiness,
    stateBackups: enterprise.stateBackups,
    restoreStateBackup: enterprise.restoreStateBackup,
    skillPacks: enterprise.skillPacks,
    setSkillPackEnabled: enterprise.setSkillPackEnabled,
    openSkillPackSource: enterprise.openSkillPackSource,
  })
  expect("enabled" in platform).toBe(false)
})
