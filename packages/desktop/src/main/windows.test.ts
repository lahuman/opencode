import { expect, test } from "bun:test"

async function run(mode: "packaged" | "dev-origin" | "dev-slash" | "dev-index") {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/../../test/windows-policy-entrypoint.ts`, mode],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

test("production windows enforce one session policy and exact packaged document navigation", async () => {
  const result = await run("packaged")

  expect(result.productionWindow).toEqual({
    mode: "packaged",
    loadedURL: "oc://renderer/index.html",
    secondLoadedURL: "oc://renderer/index.html",
    sessionRequestRegistrations: 1,
    registrations: { request: true, windowOpen: true, navigation: true, redirect: true },
  })
  expect(result.requests).toEqual({
    markdownImage: { value: { cancel: true } },
    providerStylesheet: { value: { cancel: false } },
    dataFont: { value: { cancel: false } },
    publicStylesheet: { value: { cancel: true } },
    publicFont: { value: { cancel: true } },
    rawFetch: { value: { cancel: true } },
    malformed: { value: { cancel: true } },
    rendererFile: { value: { cancel: true } },
  })
  expect(result.loggerFailure).toEqual({ value: { cancel: true }, error: "logger failed" })
  expect(result.windowOpen).toEqual({ public: { action: "deny" }, provider: { action: "deny" } })
  const navigation = {
    trusted: false,
    trustedHash: false,
    alternateDocument: true,
    asset: true,
    query: true,
    credentialed: true,
    packagedAlternate: true,
    provider: true,
    loopback: true,
    external: true,
    malformed: true,
  }
  expect(result.navigation).toEqual(navigation)
  expect(result.redirects).toEqual(navigation)
  expect(result.secondWindowHandlers).toEqual({
    windowOpen: { action: "deny" },
    navigation: false,
    redirect: true,
  })
  expect(result.protocol.registered).toBe(true)
  expect(result.protocol.partitions).toEqual(["opencode-renderer-assets"])
  expect(result.protocol.assetFetches).toHaveLength(7)
  expect(result.protocol.assets).toEqual([
    { path: "index.html", status: 200, type: "text/html" },
    { path: "assets/app.js", status: 200, type: "text/javascript" },
    { path: "assets/app.css", status: 200, type: "text/css" },
    { path: "assets/font.woff2", status: 200, type: "font/woff2" },
    { path: "assets/icon.png", status: 200, type: "image/png" },
  ])
  expect(result.protocol.rejections).toEqual({
    invalidURL: 404,
    host: 404,
    traversal: 404,
    malformedEncoding: 404,
    missing: 404,
    fetchError: 404,
  })
  expect(result.ordinaryRegistrations).toEqual({
    requestRegistrations: 1,
    windowOpen: false,
    navigation: false,
    redirect: false,
  })
  expect(result.conflictingPolicyError).toBe("Enterprise session policy cannot change after installation")

  const protocolLogs = result.logs.filter((entry: { service: string }) => entry.service === "protocol")
  expect(
    protocolLogs.map((entry: { metadata: Record<string, unknown> }) => Object.keys(entry.metadata).sort()),
  ).toEqual(Array.from({ length: 6 }, () => ["reason", "status"]))
  expect(protocolLogs.map((entry: { metadata: { reason: string } }) => entry.metadata.reason)).toEqual([
    "invalid-url",
    "invalid-host",
    "path-traversal",
    "invalid-encoding",
    "asset-fetch-failed",
    "asset-fetch-error",
  ])

  const serializedLogs = JSON.stringify(result.logs)
  for (const secret of [
    "renderer-secret",
    "fetch-secret",
    "font-secret",
    "style-secret",
    "malformed-secret",
    "file-secret",
    "logger-secret",
    "navigation-secret",
    "navigation-query-secret",
    "navigation-credential-secret",
    "navigation-malformed-secret",
    "asset-query-secret",
    "host-secret",
    "protocol-malformed-secret",
    "traversal-secret",
    "decode-secret",
    "missing-query-secret",
    "fetch-error-query-secret",
    "raw-error-secret",
    "Authorization",
    "/Users/private",
    "credential",
  ]) {
    expect(serializedLogs).not.toContain(secret)
  }
  expect(serializedLogs).not.toContain("request.url")
  expect(serializedLogs).not.toContain("file://")
})

test.each([
  ["dev-origin", "http://localhost:5173/index.html"],
  ["dev-slash", "http://localhost:5173/index.html"],
  ["dev-index", "http://localhost:5173/index.html"],
] as const)("production window trusts only the exact %s startup document", async (mode, loadedURL) => {
  const result = await run(mode)

  expect(result.productionWindow).toEqual({
    mode,
    loadedURL,
    secondLoadedURL: loadedURL,
    sessionRequestRegistrations: 1,
    registrations: { request: true, windowOpen: true, navigation: true, redirect: true },
  })
  expect(result.navigation).toEqual({
    trusted: false,
    trustedHash: false,
    alternateDocument: true,
    asset: true,
    query: true,
    credentialed: true,
    packagedAlternate: true,
    provider: true,
    loopback: true,
    external: true,
    malformed: true,
  })
  expect(result.redirects).toEqual(result.navigation)
  expect(result.secondWindowHandlers).toEqual({
    windowOpen: { action: "deny" },
    navigation: false,
    redirect: true,
  })
  expect(result.conflictingPolicyError).toBe("Enterprise session policy cannot change after installation")
})
