import { expect, test } from "bun:test"
import { enterpriseTelemetryEnabled } from "../enterprise"
import { desktopRuntimeFeatures } from "./runtime-features"

async function runMain(mode: "identity") {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/../../test/desktop-identity-entrypoint.ts`, mode], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
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
    dev: { appId: "ai.opencode.desktop.dev", name: "CHAI Dev" },
    beta: { appId: "ai.opencode.desktop.beta", name: "CHAI Beta" },
    prod: { appId: "ai.opencode.desktop", name: "CHAI" },
  })
})
