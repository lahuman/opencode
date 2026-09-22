import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

const layer = (flags: Parameters<typeof RuntimeFlags.layer>[0] = {}) =>
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, RuntimeFlags.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const it = testEffect(layer())
const enterprise = testEffect(layer({ enterpriseOffline: true }))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("does not preflight outside enterprise mode", () =>
    Effect.gen(function* () {
      const methods: string[] = []
      yield* withFetch(
        (request) => {
          methods.push(request.method)
          return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
        },
        (url) => exec({ url: url.toString(), format: "text" }),
      )
      expect(methods).toEqual(["GET"])
    }),
  )

  enterprise.instance("preflights before fetching in enterprise mode", () =>
    Effect.gen(function* () {
      const methods: string[] = []
      const result = yield* withFetch(
        (request) => {
          methods.push(request.method)
          if (request.method === "HEAD") return new Response(undefined, { status: 204 })
          return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
        },
        (url) => exec({ url: url.toString(), format: "text" }),
      )
      expect(methods).toEqual(["HEAD", "GET"])
      expect(result.output).toBe("hello")
    }),
  )

  enterprise.instance("skips fetching when enterprise preflight is not successful", () =>
    Effect.gen(function* () {
      const methods: string[] = []
      const exit = yield* withFetch(
        (request) => {
          methods.push(request.method)
          return new Response(undefined, { status: 405 })
        },
        (url) => Effect.exit(exec({ url: url.toString(), format: "text" })),
      )
      expect(methods).toEqual(["HEAD"])
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Enterprise URL preflight failed; fetch skipped")
      }
    }),
  )

  enterprise.instance("skips fetching when enterprise preflight times out", () =>
    Effect.gen(function* () {
      const methods: string[] = []
      const exit = yield* withFetch(
        async (request) => {
          methods.push(request.method)
          await Bun.sleep(100)
          return new Response(undefined, { status: 204 })
        },
        (url) => Effect.exit(exec({ url: url.toString(), format: "text", timeout: 0.01 })),
      )
      expect(methods).toEqual(["HEAD"])
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Enterprise URL preflight failed; fetch skipped")
      }
    }),
  )

  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )
})
