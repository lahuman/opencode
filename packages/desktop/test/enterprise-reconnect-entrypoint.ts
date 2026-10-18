import { mock } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "enterprise-reconnect-"))
Object.assign(process.env, {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: "[]",
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "test",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "test",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "test",
  XDG_DATA_HOME: join(directory, "legacy-data"),
  XDG_CONFIG_HOME: join(directory, "legacy-config"),
  XDG_STATE_HOME: join(directory, "legacy-state"),
})
mock.module("electron", () => ({
  app: { isPackaged: false, getPath: () => directory, getVersion: () => "2.0.30" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: {},
}))
mock.module("../src/main/enterprise-preflight", () => ({ runEnterprisePreflight: async () => undefined }))
mock.module("../src/main/native/logging", () => ({ setEnterpriseLogSecrets: () => {} }))
mock.module("../src/main/storage/store", () => ({ getStore: () => ({ get: () => undefined }) }))

const { enterpriseDesktop } = await import("../src/main/lifecycle/enterprise")
const enterprise = await enterpriseDesktop()
const command = [process.execPath, join(import.meta.dir, "enterprise-reconnect-server.ts")]
const read = async (server: { url: string; password: string }) => {
  const response = await fetch(server.url, { headers: { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` } })
  if (!response.ok) throw new Error("Private test server authentication failed")
  return response.json()
}
try {
  const initial = await Promise.all([enterprise.connect(command), enterprise.connect(command)])
  await enterprise.api.createProvider({
    provider: { id: "company", baseURL: "https://provider.example/v1", models: [{ id: "first" }] },
  })
  const provider = await enterprise.connect(command)
  const providerAgain = await enterprise.connect(command)
  await enterprise.api.createModel({ providerID: "company", model: { id: "second" } })
  const model = await enterprise.connect(command)
  const modelAgain = await enterprise.connect(command)
  const data = await read(model)
  process.stdout.write(JSON.stringify({
    initialShared: initial[0]?.url === initial[1]?.url,
    providerShared: provider.url === providerAgain.url && provider.password === providerAgain.password,
    modelShared: model.url === modelAgain.url && model.password === modelAgain.password,
    transitioned: initial[0]?.url !== provider.url && provider.url !== model.url,
    modelIDs: data.catalog.providers[0].models.map((model: { id: string }) => model.id),
  }))
} finally {
  await enterprise.stop()
  await rm(directory, { recursive: true, force: true })
}
