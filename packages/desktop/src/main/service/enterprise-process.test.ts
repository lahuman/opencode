import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { launchEnterpriseProcess } from "./enterprise-process"

test.each(["ready", "invalid"])("keeps credentials in the private pipe and handles %s child startup", async (result) => {
  const bootstrap = {
    password: "private-service-password",
    catalog: { schemaVersion: 1 as const, providers: [] },
    credentials: { schemaVersion: 3 as const, providers: { company: { apiKey: "private-provider-secret", headers: {} } } },
  }
  const start = launchEnterpriseProcess({
    command: [process.execPath, fileURLToPath(new URL("../../../test/enterprise-process-fixture.ts", import.meta.url))],
    env: { FIXTURE_RESULT: result },
    bootstrap,
  })
  if (result === "invalid") {
    await expect(start).rejects.toThrow("Enterprise server exited before becoming ready")
    expect(bootstrap.credentials.providers).toEqual({})
    return
  }
  const server = await start
  try {
    expect(server.url).toBe("http://127.0.0.1:12345")
    expect(server.password).toBe("private-service-password")
    expect(bootstrap.credentials.providers).toEqual({})
  } finally {
    await server.stop()
  }
})
