import { expect, test } from "bun:test"

async function run(mode: "enterprise" | "public") {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "run",
      `${import.meta.dir}/../../test/renderer-platform-entrypoint.ts`,
      mode,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  return { result: JSON.parse(stdout), stdout }
}

test("enterprise createPlatform rejects renderer egress before IPC or native fetch", async () => {
  const { result, stdout } = await run("enterprise")

  expect(result).toEqual({
    mode: "enterprise",
    openLinkCalls: ["https://llm.corp.example/docs"],
    fetchCalls: [
      { url: "https://llm.corp.example/v1/models", method: "POST" },
      { url: "http://localhost:4096/api", method: "PUT" },
    ],
    failures: [
      "Enterprise offline policy blocked https://cdn.example",
      "Enterprise offline policy blocked https://opencode.ai",
      "Enterprise offline policy blocked null",
    ],
    restartCalls: ["relaunch"],
  })
  for (const secret of ["open-link-secret", "string-secret", "url-secret", "request-secret", "/Users/private"]) {
    expect(stdout).not.toContain(secret)
  }
})

test("public createPlatform preserves openLink and fetch behavior", async () => {
  const { result } = await run("public")

  expect(result).toEqual({
    mode: "public",
    openLinkCalls: ["https://opencode.ai/docs?token=open-link-secret", "https://llm.corp.example/docs"],
    fetchCalls: [
      { url: "https://cdn.example/data.json?token=string-secret", method: "GET" },
      { url: "https://opencode.ai/data.json?token=url-secret", method: "GET" },
      { url: "file:///Users/private/credential?token=request-secret", method: "GET" },
      { url: "https://llm.corp.example/v1/models", method: "POST" },
      { url: "http://localhost:4096/api", method: "PUT" },
    ],
    failures: [null, null, null],
    restartCalls: ["relaunch"],
  })
})

test("real renderer entrypoint creates the policy-enforcing desktop platform", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "run",
      `${import.meta.dir}/../../test/renderer-index-entrypoint.tsx`,
      "enterprise",
    ],
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
    documentTitle: "Company OpenCode Pilot",
    openLinkCalls: ["https://llm.corp.example/docs"],
    fetchCalls: [{ url: "https://llm.corp.example/v1/models", method: "POST" }],
    failures: ["Enterprise offline policy blocked https://cdn.example", "Enterprise offline policy blocked null"],
  })
  for (const secret of [
    "renderer-index-open-secret",
    "renderer-index-string-secret",
    "renderer-index-request-secret",
  ]) {
    expect(stdout).not.toContain(secret)
  }
  expect(stdout).not.toContain("/Users/private")
})

test("ordinary renderer entrypoint preserves the document title", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "run",
      `${import.meta.dir}/../../test/renderer-index-entrypoint.tsx`,
      "ordinary",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ documentTitle: "OpenCode" })
})
