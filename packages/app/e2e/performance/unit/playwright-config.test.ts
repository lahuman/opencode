import { expect, test } from "bun:test"
import path from "node:path"

test("production benchmark discovery excludes the separate stability suite", () => {
  const result = Bun.spawnSync(
    [
      "node",
      "node_modules/@playwright/test/cli.js",
      "test",
      "--list",
      "--config",
      "e2e/performance/playwright.config.ts",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`

  expect(result.exitCode).toBe(0)
  expect(output).toContain("session-timeline-benchmark.spec.ts")
  expect(output).not.toContain("timeline-stability")
})
