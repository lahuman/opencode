import { describe, expect, test } from "bun:test"
import { providerConnectionForMode } from "@/components/dialog-connect-provider"
import {
  checkRemoteServerHealthForMode,
  selectServerForMode,
  serverConnectionsForMode,
  setDefaultServerForMode,
} from "@/components/dialog-select-server"
import { REMOTE_SERVERS_DISABLED_MESSAGE, ServerConnection } from "@/context/server"

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
