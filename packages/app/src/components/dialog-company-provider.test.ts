import { describe, expect, test } from "bun:test"
import {
  applyEnterpriseProviderUpdate,
  companyProviderCanStart,
  companyProviderDiagnosticResult,
  diagnoseCompanyProvider,
  enterpriseDeleteConfirmation,
  enterpriseProviderFailureKey,
  enterpriseProviderPresentation,
  providerCredentialIntent,
  validateEnterpriseProviderForm,
} from "./dialog-company-provider-state"

describe("enterprise provider form", () => {
  test("provider update preserves immutable IDs", () => {
    const result = validateEnterpriseProviderForm({
      mode: { type: "edit", providerID: "internal" },
      providerID: "changed-in-the-dom",
      name: " Internal Updated ",
      baseURL: " https://new.example/v1 ",
      models: [{ id: "code", name: " Code Updated " }],
      existingProviderIDs: new Set(["internal"]),
    })

    expect(result).toMatchObject({
      providerID: "internal",
      name: "Internal Updated",
      baseURL: "https://new.example/v1",
      models: [{ id: "code", name: "Code Updated" }],
    })
    expect(result.error).toBeUndefined()
  })

  test("rejects duplicate provider IDs only while creating", () => {
    expect(
      validateEnterpriseProviderForm({
        mode: { type: "create" },
        providerID: " INTERNAL ",
        name: "Internal",
        baseURL: "https://internal.example/v1",
        models: [],
        existingProviderIDs: new Set(["internal"]),
      }).error,
    ).toBe("Provider ID already exists")
  })

  test("rejects invalid URLs and duplicate model IDs", () => {
    expect(
      validateEnterpriseProviderForm({
        mode: { type: "create" },
        providerID: "internal",
        name: "Internal",
        baseURL: "file:///private/provider",
        models: [],
        existingProviderIDs: new Set(),
      }).error,
    ).toBe("Base URL must use http or https")
    expect(
      validateEnterpriseProviderForm({
        mode: { type: "create" },
        providerID: "internal",
        name: "Internal",
        baseURL: "https://internal.example/v1",
        models: [
          { id: "code", name: "Code" },
          { id: " CODE ", name: "Code duplicate" },
        ],
        existingProviderIDs: new Set(),
      }).error,
    ).toBe("Model IDs must be unique")
  })

  test("rejects Base URLs with credentials, query parameters, or fragments", () => {
    for (const baseURL of [
      "https://user:secret@gateway.example/v1",
      "https://gateway.example/v1?tenant=internal",
      "https://gateway.example/v1#models",
    ]) {
      expect(
        validateEnterpriseProviderForm({
          mode: { type: "create" },
          providerID: "internal",
          name: "Internal",
          baseURL,
          models: [],
          existingProviderIDs: new Set(),
        }).error,
      ).toBe("Base URL cannot include credentials, query parameters, or fragments")
    }
  })

  test("allows a provider with zero models", () => {
    const result = validateEnterpriseProviderForm({
      mode: { type: "create" },
      providerID: "empty",
      name: "Empty provider",
      baseURL: "https://empty.example/v1",
      models: [],
      existingProviderIDs: new Set(),
    })

    expect(result.models).toEqual([])
    expect(result.error).toBeUndefined()
  })
})

describe("enterprise provider credentials", () => {
  test("maps a preserved recovery code to existing restart guidance", () => {
    expect(
      enterpriseProviderFailureKey(
        Object.assign(new Error("restart_failed_recovery_failed"), { code: "restart_failed_recovery_failed" }),
      ),
    ).toBe("settings.skills.error.recoveryFailed")
    expect(enterpriseProviderFailureKey(new Error("Error invoking remote: restart_failed_rolled_back"))).toBe(
      "settings.skills.error.rolledBack",
    )
  })

  test("credential replacement sends a complete set", () => {
    expect(providerCredentialIntent("replace", " key ", [{ key: "X-Token", value: " value " }])).toEqual({
      mode: "replace",
      credentials: { apiKey: "key", headers: { "X-Token": "value" } },
    })
  })

  test("preserve and clear never carry secret values", () => {
    expect(providerCredentialIntent("preserve", "ignored", [{ key: "X-Token", value: "ignored" }])).toEqual({
      mode: "preserve",
    })
    expect(providerCredentialIntent("clear", "ignored", [{ key: "X-Token", value: "ignored" }])).toEqual({
      mode: "clear",
    })
  })

  test("rejects duplicate header names case-insensitively", () => {
    expect(
      providerCredentialIntent("replace", "", [
        { key: "X-Token", value: "first" },
        { key: "x-token", value: "second" },
      ]),
    ).toEqual({ mode: "replace", error: "Secret header names must be unique" })
  })

  test("updates provider metadata and replacement credentials atomically", async () => {
    const inputs: unknown[] = []
    const mutations: unknown[] = []
    const replaced = { schemaVersion: 1 as const, providers: [{ id: "replaced" }] }

    await applyEnterpriseProviderUpdate({
      providerID: "internal",
      name: "Internal Updated",
      baseURL: "https://new.example/v1",
      credentials: { mode: "replace", credentials: { apiKey: "secret", headers: {} } },
      updateProvider: async (input) => {
        inputs.push(input)
        return replaced
      },
      mutate: (value) => mutations.push(value),
    })

    expect(inputs).toEqual([
      {
        providerID: "internal",
        name: "Internal Updated",
        baseURL: "https://new.example/v1",
        credentials: { apiKey: "secret", headers: {} },
      },
    ])
    expect(mutations).toEqual([replaced])
  })

  test("does not reconcile metadata when an atomic credential clear fails", async () => {
    const mutations: unknown[] = []
    const inputs: unknown[] = []
    const result = applyEnterpriseProviderUpdate({
      providerID: "internal",
      name: "Internal Updated",
      baseURL: "https://new.example/v1",
      credentials: { mode: "clear" },
      updateProvider: async (input) => {
        inputs.push(input)
        throw new Error("secure storage failed")
      },
      mutate: (value) => mutations.push(value),
    })

    expect(result).rejects.toThrow("secure storage failed")
    await result.catch(() => undefined)
    expect(inputs).toEqual([
      {
        providerID: "internal",
        name: "Internal Updated",
        baseURL: "https://new.example/v1",
        clearCredentials: true,
      },
    ])
    expect(mutations).toEqual([])
  })

  test("does not reconcile metadata when an atomic credential replacement fails", async () => {
    const mutations: unknown[] = []
    const result = applyEnterpriseProviderUpdate({
      providerID: "internal",
      name: "Internal Updated",
      baseURL: "https://new.example/v1",
      credentials: { mode: "replace", credentials: { apiKey: "secret", headers: {} } },
      updateProvider: async () => {
        throw new Error("secure storage failed")
      },
      mutate: (value) => mutations.push(value),
    })

    expect(result).rejects.toThrow("secure storage failed")
    await result.catch(() => undefined)
    expect(mutations).toEqual([])
  })
})

describe("enterprise provider presentation state", () => {
  const catalog = {
    schemaVersion: 1 as const,
    default: { providerID: "internal", modelID: "code" },
    providers: [
      {
        id: "internal",
        name: "Internal",
        baseURL: "https://internal.example/v1",
        models: [
          { id: "chat", name: "Chat" },
          { id: "code", name: "Code" },
        ],
        credentials: { configured: true, headerNames: ["X-Token"] },
      },
    ],
  }

  test("derives model count, redacted credential state, and default badges", () => {
    expect(enterpriseProviderPresentation(catalog, catalog.providers[0])).toEqual({
      modelCount: "2 models",
      credentials: "Credentials configured",
      defaultModel: "Code",
      isDefaultProvider: true,
    })
  })

  test("presents credential recovery without exposing stored values", () => {
    expect(
      enterpriseProviderPresentation(catalog, {
        ...catalog.providers[0],
        credentials: {
          configured: false,
          headerNames: ["X-Token"],
          errorCode: "credential_decryption_failed",
        },
      }).credentials,
    ).toBe("Credentials must be re-entered")
  })

  test("locks all actions while one is pending and disables model actions without a model", () => {
    expect(companyProviderCanStart(undefined, true)).toBe(true)
    expect(companyProviderCanStart("save", true)).toBe(false)
    expect(companyProviderCanStart(undefined, false)).toBe(false)
  })

  test("captures immutable provider and model delete IDs", () => {
    expect(enterpriseDeleteConfirmation("provider", "internal")).toEqual({
      type: "provider",
      providerID: "internal",
    })
    expect(enterpriseDeleteConfirmation("model", "internal", "code")).toEqual({
      type: "model",
      providerID: "internal",
      modelID: "code",
    })
  })
})

describe("enterprise diagnostics", () => {
  test("targets the selected provider and model", async () => {
    const requests: unknown[] = []
    await diagnoseCompanyProvider(async (input) => requests.push(input), "internal", "code")
    expect(requests).toEqual([{ providerID: "internal", modelID: "code", checkToolCall: true }])
  })

  test("creates a stable diagnostic result for network failures", () => {
    expect(companyProviderDiagnosticResult(undefined, "Request failed")).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: { kind: "connection", message: "Request failed" },
    })
  })
})
