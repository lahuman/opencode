import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enterpriseTelemetryEnabled } from "../enterprise"
import { forwardInitializationFailure } from "./initialization"
import { desktopRuntimeFeatures } from "./runtime-features"

async function runMain(
  mode:
    | "identity"
    | "enterprise"
    | "enterprise-provider-restart"
    | "enterprise-credentials-corrupt"
    | "enterprise-credentials-unavailable"
    | "ordinary-packaged"
    | "ordinary-unpackaged",
  env?: Record<string, string>,
) {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/../../test/main-index-entrypoint.ts`, mode], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  return { result: JSON.parse(stdout), stdout }
}

test("enterprise profile disables updater and WSL", () => {
  expect(desktopRuntimeFeatures({ packaged: true, channel: "prod", enterprise: true })).toEqual({
    updater: false,
    wsl: false,
  })
})

test("ordinary production keeps updater and WSL", () => {
  expect(desktopRuntimeFeatures({ packaged: true, channel: "prod", enterprise: false })).toEqual({
    updater: true,
    wsl: true,
  })
})

test("enterprise profile disables telemetry even when a DSN is present", () => {
  expect(enterpriseTelemetryEnabled({ enabled: true }, "https://sentry.example/1")).toBe(false)
  expect(enterpriseTelemetryEnabled({ enabled: false }, "https://sentry.example/1")).toBe(true)
})

test("desktop identity covers enterprise and every ordinary channel", async () => {
  const { result } = await runMain("identity")

  expect(result).toEqual({
    enterpriseProd: { appId: "com.company.sfmi", name: "CHAI" },
    enterpriseDev: { appId: "com.company.sfmi", name: "CHAI" },
    dev: { appId: "ai.opencode.desktop.dev", name: "OpenCode Dev" },
    beta: { appId: "ai.opencode.desktop.beta", name: "OpenCode Beta" },
    prod: { appId: "ai.opencode.desktop", name: "OpenCode" },
  })
})

test("real enterprise main entrypoint applies isolated identity without claiming opencode protocol", async () => {
  const { result, stdout } = await runMain("enterprise")

  expect(result).toEqual({
    rendererProtocolRegistrations: 1,
    preflightCalls: 1,
    statePrepared: 1,
    stateHealthy: 1,
    ipcRegistered: true,
    shellOpenExternalURLs: ["https://llm.corp.example/docs"],
    identity: {
      appId: "com.company.sfmi",
      name: "CHAI",
      userData: join(tmpdir(), "opencode-main-index-app-data", "com.company.sfmi"),
    },
    protocolClients: [],
  })
  expect(stdout).not.toContain("main-index-secret")
  expect(stdout).not.toContain("user:secret")
})

test("enterprise provider mutation restarts the sidecar with the complete current state", async () => {
  const { result, stdout } = await runMain("enterprise-provider-restart")

  expect(result).toEqual({
    mutation: {
      schemaVersion: 1,
      default: { providerID: "company-llm", modelID: "company-code" },
      providers: [
        {
          id: "company-llm",
          name: "Company Code",
          baseURL: "https://llm.corp.example/v1",
          models: [{ id: "company-code", name: "Company Code" }],
          credentials: { configured: true, headerNames: ["Authorization"] },
        },
      ],
    },
    sidecarStarts: 2,
    sidecarStops: 1,
    relaunches: 0,
    sidecarStates: [
      {
        default: { providerID: "company-llm", modelID: "company-code" },
        providers: ["company-llm"],
        credentialProviders: [],
      },
      {
        default: { providerID: "company-llm", modelID: "company-code" },
        providers: ["company-llm"],
        credentialProviders: ["company-llm"],
      },
    ],
  })
  expect(stdout).not.toContain("entrypoint-secret")
  expect(stdout).not.toContain("header-secret")
})

test("unhealthy enterprise credentials preserve startup, redaction, and mutation isolation", async () => {
  for (const input of [
    {
      mode: "enterprise-credentials-corrupt" as const,
      errorCode: "credential_decryption_failed",
      providerID: "existing",
      providerName: "Existing Provider",
    },
    {
      mode: "enterprise-credentials-unavailable" as const,
      errorCode: "credential_encryption_unavailable",
      providerID: "company-llm",
      providerName: "Company Code",
    },
  ]) {
    const { result, stdout } = await runMain(input.mode)

    expect(result.providerCatalog).toEqual({
      schemaVersion: 1,
      default: { providerID: input.providerID, modelID: "company-code" },
      providers: [
        {
          id: input.providerID,
          name: input.providerName,
          baseURL:
            input.mode === "enterprise-credentials-corrupt"
              ? "https://existing.example/v1"
              : "https://llm.corp.example/v1",
          models: [
            {
              id: "company-code",
              name: input.mode === "enterprise-credentials-corrupt" ? "Existing Code" : "Company Code",
            },
          ],
          credentials: { configured: false, headerNames: [], errorCode: input.errorCode },
        },
      ],
    })
    expect(result.mutationError).toBe(input.errorCode)
    expect(result.sidecarStarts).toBe(1)
    expect(result.sidecarStates).toEqual([
      {
        default: { providerID: input.providerID, modelID: "company-code" },
        providers: [input.providerID],
        credentialProviders: [],
      },
    ])
    expect(result.credentialUnchanged).toBe(true)
    expect(result.credentialTimestampUnchanged).toBe(true)
    expect(stdout).not.toContain("unreadable-encrypted-main-index-secret")
    expect(stdout).not.toContain("unavailable-main-index-secret")
    expect(stdout).not.toContain("replacement-main-index-secret")
    expect(stdout).not.toContain("secret-header")
  }
})

test("ordinary packaged and unpackaged main entrypoints preserve their identities and protocol", async () => {
  const packaged = await runMain("ordinary-packaged")
  const unpackaged = await runMain("ordinary-unpackaged")

  expect(packaged.result.identity).toEqual({
    appId: "ai.opencode.desktop",
    name: "OpenCode",
    userData: join(tmpdir(), "opencode-main-index-app-data", "ai.opencode.desktop"),
  })
  expect(unpackaged.result.identity).toEqual({
    appId: "ai.opencode.desktop.dev",
    name: "OpenCode Dev",
    userData: join(tmpdir(), "opencode-main-index-app-data", "ai.opencode.desktop.dev"),
  })
  expect(packaged.result.protocolClients).toEqual(["opencode"])
  expect(unpackaged.result.protocolClients).toEqual(["opencode"])
})

test("onboarding test roots override the desktop user data location", async () => {
  const { result } = await runMain("enterprise", { OPENCODE_TEST_ONBOARDING: "1" })

  expect(result.identity.userData).toMatch(/opencode-onboarding-[^/\\]+[/\\]desktop$/)
})

describe("desktop initialization", () => {
  const failure = new Error("sidecar startup failed")
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expectFailure(exit)
  })

  test("forwards loading task failures while renderer initialization waits", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Fiber.join(waiting)
      }),
    )

    expectFailure(exit)
  })
})
