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
} from "./dialog-company-provider"
import { providerConnectionForMode } from "./dialog-connect-provider"
import {
  checkRemoteServerHealthForMode,
  selectServerForMode,
  serverConnectionsForMode,
  setDefaultServerForMode,
} from "./dialog-select-server"
import { REMOTE_SERVERS_DISABLED_MESSAGE, ServerConnection } from "@/context/server"

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

describe("enterprise provider diversion", () => {
  test("chooses Company LLM without entering the ordinary auth path", () => {
    const calls: string[] = []
    const result = providerConnectionForMode({
      enterprise: true,
      company: () => {
        calls.push("company")
        return "company"
      },
      ordinary: () => {
        calls.push("auth.set")
        return "ordinary"
      },
    })

    expect(result).toBe("company")
    expect(calls).toEqual(["company"])
  })

  test("preserves the ordinary provider connection path", () => {
    expect(
      providerConnectionForMode({ enterprise: false, company: () => "company", ordinary: () => "ordinary" }),
    ).toBe("ordinary")
  })
})

describe("enterprise default server policy", () => {
  test("rejects before platform default-server storage", async () => {
    const writes: Array<string | null> = []
    const result = setDefaultServerForMode({
      enterprise: true,
      key: ServerConnection.Key.make("https://remote.example.test"),
      setDefault: async (key) => {
        writes.push(key)
      },
    })

    expect(result).rejects.toThrow(REMOTE_SERVERS_DISABLED_MESSAGE)
    await result.catch(() => undefined)
    expect(writes).toEqual([])
  })

  test("preserves ordinary default-server storage", async () => {
    const writes: Array<string | null> = []
    await setDefaultServerForMode({
      enterprise: false,
      key: null,
      setDefault: async (key) => {
        writes.push(key)
      },
    })
    expect(writes).toEqual([null])
  })
})

describe("enterprise server management operations", () => {
  const remote = { type: "http" as const, http: { url: "https://remote.example.test" } }

  test("rejects remote add validation before a health probe", async () => {
    const probes: string[] = []
    const result = checkRemoteServerHealthForMode({
      enterprise: true,
      server: remote.http,
      check: async (server) => {
        probes.push(server.url)
        return { healthy: true }
      },
    })

    expect(result).rejects.toThrow(REMOTE_SERVERS_DISABLED_MESSAGE)
    await result.catch(() => undefined)
    expect(probes).toEqual([])
  })

  test("rejects remote selection before close, persistence, navigation, or activation", async () => {
    const calls: string[] = []
    const result = selectServerForMode({
      enterprise: true,
      connection: remote,
      persist: true,
      healthy: true,
      close: () => calls.push("close"),
      persistConnection: () => calls.push("persist"),
      navigate: () => calls.push("navigate"),
      activate: () => calls.push("activate"),
    })

    expect(result).rejects.toThrow(REMOTE_SERVERS_DISABLED_MESSAGE)
    await result.catch(() => undefined)
    expect(calls).toEqual([])
  })

  test("preserves ordinary persisted selection behavior", async () => {
    const calls: string[] = []
    await selectServerForMode({
      enterprise: false,
      connection: remote,
      persist: true,
      healthy: true,
      close: () => calls.push("close"),
      persistConnection: () => calls.push("persist"),
      navigate: () => calls.push("navigate"),
      activate: () => calls.push("activate"),
    })
    expect(calls).toEqual(["close", "persist", "navigate"])
  })
})

describe("serverConnectionsForMode", () => {
  const connections = [
    {
      displayName: "Local Server",
      type: "sidecar" as const,
      variant: "base" as const,
      http: { url: "http://127.0.0.1:4096" },
    },
    {
      displayName: "WSL",
      type: "sidecar" as const,
      variant: "wsl" as const,
      distro: "Ubuntu",
      http: { url: "http://127.0.0.1:4097" },
    },
    {
      displayName: "Remote",
      type: "http" as const,
      http: { url: "https://remote.example.test" },
    },
    {
      displayName: "SSH",
      type: "ssh" as const,
      host: "workstation",
      http: { url: "http://127.0.0.1:4098" },
    },
  ]

  test("returns only the built-in sidecar in enterprise mode", () => {
    expect(serverConnectionsForMode(true, connections)).toEqual([connections[0]])
  })

  test("preserves ordinary server choices", () => {
    expect(serverConnectionsForMode(false, connections)).toBe(connections)
  })
})
