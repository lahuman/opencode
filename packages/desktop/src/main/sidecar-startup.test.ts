import { expect, test } from "bun:test"
import { createSidecarEnv, createSidecarStartCommand, postSidecarStartCommand } from "./sidecar-startup"

test("sidecar startup transfers and releases the provider catalog and credentials", () => {
  const catalog = {
    schemaVersion: 1 as const,
    default: { providerID: "internal", modelID: "code" },
    providers: [
      {
        id: "internal",
        name: "Internal",
        baseURL: "https://internal.example/v1",
        models: [{ id: "code", name: "Code" }],
      },
    ],
  }
  const credentials = {
    schemaVersion: 3 as const,
    providers: { internal: { apiKey: "secret-key", headers: { Authorization: "secret-header" } } },
  }
  const owner = { catalog, credentials }
  let posted: ReturnType<typeof createSidecarStartCommand> | undefined

  postSidecarStartCommand(
    {
      hostname: "127.0.0.1",
      port: 4096,
      password: "sidecar-password",
      userDataPath: "C:\\OpenCode",
    },
    owner,
    (command) => {
      posted = structuredClone(command)
    },
  )

  expect(posted?.catalog).toEqual(catalog)
  expect(posted?.credentials).toEqual(credentials)
  expect(owner.catalog).toBeUndefined()
  expect(owner.credentials).toBeUndefined()
})

test("sidecar environment discards inherited enterprise startup data", () => {
  const env = createSidecarEnv(
    {},
    {
      inherited: {
        OPENCODE_ENTERPRISE_PROVIDER_CATALOG: '{"attacker":true}',
        OPENCODE_ENTERPRISE_CREDENTIALS: "inherited-secret",
      },
      platform: "win32",
      packaged: true,
    },
  )

  expect(env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG).toBeUndefined()
  expect(env.OPENCODE_ENTERPRISE_CREDENTIALS).toBeUndefined()
})
