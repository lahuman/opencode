import { expect, test } from "bun:test"
import { enterpriseSidecarEnvironment } from "./enterprise-credentials"
import { createSidecarEnv, createSidecarStartCommand, postSidecarStartCommand } from "./sidecar-startup"

test("sidecar environment blocks shared plaintext credential sources", () => {
  expect(enterpriseSidecarEnvironment()).toEqual({
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  })
})

test("enterprise credentials travel by startup message and never by environment", () => {
  const credentials = {
    apiKey: "secret-key",
    headers: { "X-Company-Token": "secret-header" },
  }
  const env = createSidecarEnv(enterpriseSidecarEnvironment(), {
    inherited: {
      PATH: "C:\\Windows",
      OPENCODE_AUTH_CONTENT: '{"legacy":"secret-key"}',
      OPENCODE_CONFIG_CONTENT: '{"provider":"secret-header"}',
      OPENCODE_ENTERPRISE_CREDENTIALS: "inherited-secret",
    },
    platform: "win32",
    packaged: true,
  })
  const command = createSidecarStartCommand({
    hostname: "127.0.0.1",
    port: 4096,
    password: "sidecar-password",
    userDataPath: "C:\\OpenCode",
    credentials,
  })

  expect(command.credentials).toEqual(credentials)
  expect(JSON.stringify(env)).not.toContain("secret-key")
  expect(JSON.stringify(env)).not.toContain("secret-header")
  expect(env).toMatchObject({
    PATH: "C:\\Windows",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: "{}",
  })
  expect(env.OPENCODE_ENTERPRISE_CREDENTIALS).toBeUndefined()
})

test("ordinary sidecar environment preserves standard auth and config overrides", () => {
  const env = createSidecarEnv(
    {},
    {
      inherited: {
        OPENCODE_AUTH_CONTENT: '{"provider":"ordinary-auth"}',
        OPENCODE_CONFIG_CONTENT: '{"provider":"ordinary-config"}',
        OPENCODE_ENTERPRISE_CREDENTIALS: "inherited-secret",
      },
      platform: "win32",
      packaged: true,
    },
  )

  expect(env.OPENCODE_AUTH_CONTENT).toBe('{"provider":"ordinary-auth"}')
  expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"provider":"ordinary-config"}')
  expect(env.OPENCODE_ENTERPRISE_CREDENTIALS).toBeUndefined()
})

test("successful sidecar post releases credentials from the long-lived owner", () => {
  const credentials = {
    apiKey: "secret-key",
    headers: { Authorization: "secret-header" },
  }
  const owner = { credentials }
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

  expect(posted?.credentials).toEqual(credentials)
  expect(owner.credentials).toBeUndefined()
})

test("failed sidecar post does not report credentials as released", () => {
  const credentials = { apiKey: "secret-key", headers: {} }
  const owner = { credentials }

  expect(() =>
    postSidecarStartCommand(
      {
        hostname: "127.0.0.1",
        port: 4096,
        password: "sidecar-password",
        userDataPath: "C:\\OpenCode",
      },
      owner,
      () => {
        throw new Error("post failed")
      },
    ),
  ).toThrow("post failed")
  expect(owner.credentials).toBe(credentials)
})
