import { mock } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEnterpriseProviderRuntime } from "../src/main/enterprise-provider-runtime"
import { readEnterpriseGuide } from "../src/main/enterprise-guide"

Object.assign(process.env, {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: "[]",
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "test",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "test",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "test",
})
const directory = await mkdtemp(join(tmpdir(), "enterprise-ipc-"))
const path = join(directory, "guide.md")
await writeFile(path, "# Registered guide\n")
const catalog = {
  schemaVersion: 1 as const,
  default: { providerID: "company", modelID: "company-code" },
  providers: [
    {
      id: "company",
      name: "Company",
      baseURL: "https://llm.corp.example/v1",
      models: [{ id: "company-code", name: "Company Code" }],
    },
  ],
}
const credentials = {
  schemaVersion: 3 as const,
  providers: { company: { headers: { Authorization: "private-ipc-secret" } } },
}
const providers = createEnterpriseProviderRuntime({
  catalog: { read: async () => catalog, write: async () => undefined },
  credentials: {
    read: async () => credentials,
    write: async () => undefined,
    health: async () => ({ state: "available" as const }),
  },
  restart: async () => undefined,
})
const api = {
  ...providers,
  readGuide: () => readEnterpriseGuide({ enabled: true, path, version: "2026.08" }),
  readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "pass", checks: [] }),
  stateBackups: async () => [],
  restoreStateBackup: async () => ({ restartRequired: true }),
  skillPacks: async () => [],
  setSkillPackEnabled: async () => [],
  openSkillPackSource: async () => undefined,
}
let invoke: ((event: unknown, method: unknown, args: unknown) => unknown) | undefined
mock.module("electron", () => ({
  app: { isPackaged: true },
  protocol: {},
  ipcMain: {
    handle: (_channel: string, handler: typeof invoke) => {
      invoke = handler
    },
  },
}))
mock.module("../src/main/lifecycle/enterprise", () => ({ enterpriseDesktop: async () => ({ api }) }))
try {
  const { registerEnterpriseHandlers } = await import("../src/main/ipc-handlers/enterprise")
  await registerEnterpriseHandlers()
  if (!invoke) throw new Error("Enterprise IPC was not registered")
  const sender = (url: string) => {
    const frame = { url }
    return { sender: { mainFrame: frame }, senderFrame: frame }
  }
  const trusted = sender("oc://renderer/index.html")
  const failure = async (event: unknown, method: string, args: unknown) => {
    try {
      await invoke!(event, method, args)
      return "accepted"
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const failures = [
    await failure({ sender: trusted.sender }, "readGuide", []),
    await failure(sender("https://public.example"), "readGuide", []),
    await failure(sender("oc://renderer/index.html?token=private"), "readGuide", []),
    await failure(trusted, "unknown", []),
    await failure(trusted, "replaceProviderCredentials", [
      { providerID: "company", credentials: { apiKey: 123, headers: {} } },
    ]),
    await failure(trusted, "replaceProviderCredentials", [
      { providerID: "company", credentials: { apiKey: "", headers: { Authorization: 123 } } },
    ]),
  ]
  process.stdout.write(
    JSON.stringify({
      providerCatalog: await invoke(trusted, "providerCatalog", []),
      guide: await invoke(trusted, "readGuide", []),
      failures,
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
