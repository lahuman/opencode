import { expect, test } from "bun:test"

test("production window and packaged protocol enforce enterprise boundaries", async () => {
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
  const result = JSON.parse(stdout)

  expect(result.productionWindow).toEqual({
    loadedURL: "oc://renderer/index.html",
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
  expect(result.navigation).toEqual({ trusted: false, provider: true, loopback: true, external: true })
  expect(result.redirects).toEqual({ trusted: false, provider: true, loopback: true, external: true })
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
    request: false,
    windowOpen: false,
    navigation: false,
    redirect: false,
  })

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
    "redirect-provider-secret",
    "redirect-loopback-secret",
    "redirect-external-secret",
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
