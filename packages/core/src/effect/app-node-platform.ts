import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Socket } from "effect/socket"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { WebSocketConstructor } from "./websocket-constructor.js"
import { Enterprise } from "../enterprise.js"

// Bun's fetch ends a request after five quiet minutes, before provider routes' own header and chunk timeouts.
const withoutBunTimeout = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const guarded = Enterprise.enabled()
      ? client.pipe(
          HttpClient.mapRequestEffect((request) =>
            Effect.sync(() => {
              Enterprise.requireURL(request.url)
              return request
            }),
          ),
          HttpClient.transformResponse((response) =>
            response.pipe(
              Effect.flatMap((value) =>
                [301, 302, 303, 307, 308].includes(value.status)
                  ? Effect.die(new Error("Enterprise provider redirects are disabled"))
                  : Effect.succeed(value),
              ),
            ),
          ),
        )
      : client
    return HttpClient.transformResponse(
      guarded,
      Effect.provideService(FetchHttpClient.RequestInit, {
        timeout: false,
        ...(Enterprise.enabled() ? { redirect: "manual" } : {}),
      } as BunFetchRequestInit),
    )
  }),
)

export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer.pipe(Layer.provide(withoutBunTimeout)),
  deps: [httpClient],
})

export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export const webSocketConstructor = makeGlobalNode({
  service: Socket.WebSocketConstructor,
  layer: WebSocketConstructor.layer,
  deps: [],
})

export * as LayerNodePlatform from "./app-node-platform.js"
