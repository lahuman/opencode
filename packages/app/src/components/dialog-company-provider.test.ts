import { describe, expect, test } from "bun:test"
import {
  applyCompanyProviderCredentialMutation,
  companyProviderCanStart,
  companyProviderConfig,
  companyProviderCredentialStatus,
  companyProviderCredentialInput,
  diagnoseCompanyProvider,
  companyProviderDiagnosticResult,
  companyProviderModels,
  companyProviderShouldRestart,
} from "./dialog-company-provider-state"

describe("companyProviderCredentialInput", () => {
  test("trims secrets without placing them in provider config", () => {
    expect(companyProviderCredentialInput(" secret ", [{ key: " X-Token ", value: " value " }])).toEqual({
      apiKey: "secret",
      headers: { "X-Token": "value" },
    })
  })

  test("omits untouched credential kinds so main can preserve encrypted values", () => {
    expect(
      companyProviderCredentialInput("", [
        { key: "", value: "" },
        { key: "X-Key", value: "" },
        { key: "", value: "secret" },
      ]),
    ).toEqual({})
  })

  test("resolves duplicate header names case-insensitively with the last complete row", () => {
    expect(
      companyProviderCredentialInput("", [
        { key: " X-Token ", value: " first " },
        { key: "x-token", value: " second " },
        { key: "X-Other", value: " third " },
      ]),
    ).toEqual({
      headers: {
        "x-token": "second",
        "X-Other": "third",
      },
    })
  })
})

describe("company provider config", () => {
  test("reads configured company models", () => {
    expect(
      companyProviderModels({
        provider: { "company-llm": { models: { code: { name: "Company Code" } } } },
      }),
    ).toEqual([{ id: "code", name: "Company Code" }])
  })

  test("projects only public setup data from provider options", () => {
    const config = companyProviderConfig({
      provider: {
        "company-llm": {
          options: {
            baseURL: "https://llm.company.test/v1",
            apiKey: "must-not-escape",
            headers: { Authorization: "must-not-escape" },
          },
          models: { code: { name: "Company Code" }, fallback: {} },
        },
      },
    })

    expect(config).toEqual({
      baseURL: "https://llm.company.test/v1",
      models: [
        { id: "code", name: "Company Code" },
        { id: "fallback", name: "fallback" },
      ],
    })
    expect(JSON.stringify(config)).not.toContain("must-not-escape")
  })
})

describe("company provider operation state", () => {
  test("blocks missing prerequisites and double submission", () => {
    expect(companyProviderCanStart(undefined, true)).toBe(true)
    expect(companyProviderCanStart("diagnose", true)).toBe(false)
    expect(companyProviderCanStart(undefined, false)).toBe(false)
  })

  test("restarts only when the enterprise mutation requests it", () => {
    expect(companyProviderShouldRestart({ restartRequired: true })).toBe(true)
    expect(companyProviderShouldRestart({ restartRequired: false })).toBe(false)
    expect(companyProviderShouldRestart(undefined)).toBe(false)
  })

  test("creates a stable diagnostic result for network failures", () => {
    expect(companyProviderDiagnosticResult(undefined, "Request failed")).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: { kind: "connection", message: "Request failed" },
    })
  })

  test("renders loading, configured, empty, and failed credential status", () => {
    expect(companyProviderCredentialStatus({ loading: true }, "Request failed")).toBe("Checking credentials...")
    expect(companyProviderCredentialStatus({ loading: false, configured: true }, "Request failed")).toBe(
      "Credentials configured",
    )
    expect(companyProviderCredentialStatus({ loading: false, configured: false }, "Request failed")).toBe(
      "Credentials not configured",
    )
    expect(companyProviderCredentialStatus({ loading: false, error: new Error("offline") }, "Request failed")).toBe(
      "Request failed",
    )
  })

  test("clears dialog secrets before a requested restart", async () => {
    const events: string[] = []
    await applyCompanyProviderCredentialMutation({
      mutation: async () => {
        events.push("setCredentials")
        return { restartRequired: true }
      },
      clearLocal: () => events.push("clearLocal"),
      restart: async () => {
        events.push("restart")
      },
    })
    expect(events).toEqual(["setCredentials", "clearLocal", "restart"])
  })

  test("does not clear or restart when credential storage fails", async () => {
    const events: string[] = []
    const result = applyCompanyProviderCredentialMutation({
      mutation: async () => {
        events.push("setCredentials")
        throw new Error("secure storage failed")
      },
      clearLocal: () => events.push("clearLocal"),
      restart: async () => {
        events.push("restart")
      },
    })
    expect(result).rejects.toThrow("secure storage failed")
    await result.catch(() => undefined)
    expect(events).toEqual(["setCredentials"])
  })

  test("does not restart when the enterprise API does not request it", async () => {
    const events: string[] = []
    await applyCompanyProviderCredentialMutation({
      mutation: async () => ({ restartRequired: false }),
      clearLocal: () => events.push("clearLocal"),
      restart: async () => {
        events.push("restart")
      },
    })
    expect(events).toEqual(["clearLocal"])
  })

  test("sends the generated company provider diagnose request", async () => {
    const requests: unknown[] = []
    const diagnostic = {
      ok: true,
      checks: { basic: "pass", streaming: "pass", toolCall: "pass" } as const,
    }
    const result = await diagnoseCompanyProvider(
      async (input) => {
        requests.push(input)
        return { data: diagnostic }
      },
      "company-code",
    )

    expect(requests).toEqual([
      { providerID: "company-llm", modelID: "company-code", checkToolCall: true },
    ])
    expect(result.data).toEqual(diagnostic)
  })
})
