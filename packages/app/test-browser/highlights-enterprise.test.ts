import { expect, test } from "bun:test"

test("mounted HighlightsProvider enforces enterprise short circuit and preserves public loading", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "run", `${import.meta.dir}/fixtures/highlights-provider-entrypoint.ts`],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    enterprise: { calls: ["seen 2.0.0"], stored: { version: "2.0.0" } },
    public: {
      calls: ["select fetcher", "network", "seen 2.0.0"],
      stored: { version: "2.0.0" },
    },
  })
})
