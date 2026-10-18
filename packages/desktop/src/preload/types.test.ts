import { expect, test } from "bun:test"
import { createEnterpriseBridge, type EnterpriseAPI } from "../shared/enterprise"

test("forwards ID-only provider and model operations through the private enterprise bridge", async () => {
  const calls: { method: keyof EnterpriseAPI; args: unknown[] }[] = []
  const bridge = createEnterpriseBridge((method, args) => {
    calls.push({ method, args })
    // SAFETY: this dispatch test observes arguments only and does not consume response data.
    return Promise.resolve(undefined) as ReturnType<EnterpriseAPI[typeof method]>
  })
  const provider = { id: "provider", baseURL: "https://provider.example/v1", models: [{ id: "model" }] }
  const credentials = { apiKey: "private-test-key", headers: {} }
  await bridge.providerCatalog()
  await bridge.createProvider({ provider, credentials })
  await bridge.updateProvider({ providerID: "provider", baseURL: "https://updated.example/v1", credentials })
  await bridge.createModel({ providerID: "provider", model: { id: "second" } })
  await bridge.setDefaultModel({ providerID: "provider", modelID: "second" })
  await bridge.deleteModel({ providerID: "provider", modelID: "second" })
  await bridge.deleteProvider("provider")
  expect(calls).toEqual([
    { method: "providerCatalog", args: [] },
    { method: "createProvider", args: [{ provider, credentials }] },
    { method: "updateProvider", args: [{ providerID: "provider", baseURL: "https://updated.example/v1", credentials }] },
    { method: "createModel", args: [{ providerID: "provider", model: { id: "second" } }] },
    { method: "setDefaultModel", args: [{ providerID: "provider", modelID: "second" }] },
    { method: "deleteModel", args: [{ providerID: "provider", modelID: "second" }] },
    { method: "deleteProvider", args: ["provider"] },
  ])
})
