import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test.each(["model-selection", "desktop-agent"])(
  "LocalProvider %s integration",
  async (name) => {
    // Isolate provider module substitutions from the rest of the browser suite.
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        `./test-browser/fixtures/${name}.ts`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
    )

    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(status, stdout + stderr).toBe(0)
  },
  30_000,
)
