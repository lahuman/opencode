import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { createEnterpriseURLHandler, enterpriseTelemetryEnabled, parseEnterpriseProfile } from "../enterprise"
import { forwardInitializationFailure } from "./initialization"
import { desktopRuntimeFeatures } from "./runtime-features"

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

test("main external URL policy rejects before shell.openExternal", async () => {
  const calls: string[] = []
  const openExternalURL = createEnterpriseURLHandler(
    parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
    }),
    async (url) => {
      calls.push(url)
    },
  )

  await openExternalURL("https://opencode.ai/docs?token=main-secret")
  await openExternalURL("https://llm.corp.example/docs")
  await openExternalURL("https://user:secret@llm.corp.example/docs")

  expect(calls).toEqual(["https://llm.corp.example/docs"])
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
