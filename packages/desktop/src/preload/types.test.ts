import { expect, test } from "bun:test"
import { createEnterpriseAPI, mapEnterpriseAPI } from "./types"

test("maps enterprise guide reads to the main IPC channel", async () => {
  const invocations: { channel: string; args: unknown[] }[] = []
  const enterprise = createEnterpriseAPI(true, (channel, ...args) => {
    invocations.push({ channel, args })
    return Promise.resolve({ version: "2026.07", markdown: "# Company guide" })
  })

  await expect(enterprise.readGuide()).resolves.toEqual({ version: "2026.07", markdown: "# Company guide" })
  expect(invocations).toEqual([{ channel: "enterprise-guide-read", args: [] }])
})

test("maps the preload enterprise API to the app platform contract", () => {
  const enterprise = {
    enabled: true,
    credentialStatus: async () => ({ configured: true }),
    setCredentials: async () => ({ restartRequired: true as const }),
    clearCredentials: async () => ({ restartRequired: true as const }),
    readGuide: async () => ({ version: "2026.07", markdown: "# Company guide" }),
  }

  const platform = mapEnterpriseAPI(enterprise)

  expect(platform).toEqual({
    credentialStatus: enterprise.credentialStatus,
    setCredentials: enterprise.setCredentials,
    clearCredentials: enterprise.clearCredentials,
    readGuide: enterprise.readGuide,
  })
  expect("enabled" in platform).toBe(false)
})
