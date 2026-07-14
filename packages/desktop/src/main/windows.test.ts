import { expect, test } from "bun:test"

test("enterprise windows install request, window-open, and navigation boundaries", async () => {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/../../test/windows-policy-entrypoint.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    registrations: { request: true, windowOpen: true, navigation: true },
    requests: {
      markdownImage: { cancel: true },
      providerStylesheet: { cancel: false },
      dataFont: { cancel: false },
      publicStylesheet: { cancel: true },
      publicFont: { cancel: true },
      rawFetch: { cancel: true },
      malformed: { cancel: true },
    },
    windowOpen: {
      public: { action: "deny" },
      provider: { action: "deny" },
    },
    navigation: { trustedPrevented: false, externalPrevented: true },
    logs: [
      { origin: "https://cdn.example", resourceType: "image" },
      { origin: "https://cdn.example", resourceType: "stylesheet" },
      { origin: "https://fonts.example", resourceType: "font" },
      { origin: "https://opencode.ai", resourceType: "xhr" },
      { origin: "<invalid>", resourceType: "other" },
      { origin: "https://opencode.ai", resourceType: "windowOpen" },
      { origin: "https://llm.corp.example", resourceType: "windowOpen" },
      { origin: "https://llm.corp.example", resourceType: "mainFrame" },
    ],
    ordinaryRegistrations: { request: false, windowOpen: false, navigation: false },
  })
  expect(stdout).not.toContain("renderer-secret")
  expect(stdout).not.toContain("fetch-secret")
  expect(stdout).not.toContain("style-secret")
  expect(stdout).not.toContain("font-secret")
  expect(stdout).not.toContain("malformed-secret")
  expect(stdout).not.toContain("Authorization")
  expect(stdout).not.toContain("/private.png")
})
