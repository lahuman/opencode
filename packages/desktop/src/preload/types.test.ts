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
      invocations: [{ channel: "enterprise-guide-read", args: [] }],
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

test("maps the preload enterprise API to the app platform contract", () => {
  const enterprise = {
    enabled: true,
    credentialStatus: async () => ({ configured: true }),
    setCredentials: async () => ({ restartRequired: true as const }),
    clearCredentials: async () => ({ restartRequired: true as const }),
    readGuide: async () => ({ version: "2026.07", markdown: "# Company guide" }),
    readiness: async () => ({ schemaVersion: 1 as const, generatedAt: "now", overall: "pass" as const, checks: [] }),
    stateBackups: async () => [],
    restoreStateBackup: async () => ({ restartRequired: true as const }),
  }

  const platform = mapEnterpriseAPI(enterprise)

  expect(platform).toEqual({
    credentialStatus: enterprise.credentialStatus,
    setCredentials: enterprise.setCredentials,
    clearCredentials: enterprise.clearCredentials,
    readGuide: enterprise.readGuide,
    readiness: enterprise.readiness,
    stateBackups: enterprise.stateBackups,
    restoreStateBackup: enterprise.restoreStateBackup,
  })
  expect("enabled" in platform).toBe(false)
})
