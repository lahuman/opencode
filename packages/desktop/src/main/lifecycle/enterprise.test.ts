import { expect, test } from "bun:test"
import { join } from "node:path"

test("enterprise reconnects reuse the live server after provider and model mutations", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../test/enterprise-reconnect-entrypoint.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    initialShared: true,
    providerShared: true,
    modelShared: true,
    transitioned: true,
    modelIDs: ["first", "second"],
  })
})
