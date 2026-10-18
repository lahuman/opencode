export * as EnterprisePlugin from "./enterprise.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { Enterprise } from "../enterprise.js"
import PROMPT from "./system-prompt/enterprise.txt" with { type: "text" }

export const Plugin = define({
  id: "opencode.enterprise",
  effect: Effect.fn(function* (ctx) {
    if (!Enterprise.enabled()) return
    const policy = Enterprise.settings()
    const catalog = new Map(policy.catalog.providers.map((provider) => [provider.id, provider]))
    for (const name of ["context", "generate", "title", "compaction"] as const)
      yield* ctx.session.hook(name, (event) => {
        if (!event.system.some((part) => part.text === PROMPT)) event.system.push({ type: "text", text: PROMPT })
        return Effect.void
      })

    yield* ctx.provider.transform((providers) => {
      for (const current of providers.list()) {
        if (!catalog.has(current.provider.id)) providers.remove(current.provider.id)
      }
      for (const item of policy.catalog.providers) {
        const id = Provider.ID.make(item.id)
        providers.update(id, (provider) => {
          provider.name = item.id
          provider.activation = "enabled"
          provider.integrationID = undefined
          provider.canonical = undefined
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.headers = undefined
          provider.settings = {
            ...Object.fromEntries(
              Object.entries(provider.settings ?? {}).filter(
                ([key]) => !["apiKey", "key", "headers", "baseURL", "fetch", "provider"].includes(key),
              ),
            ),
            baseURL: item.baseURL,
            provider: item.id,
          }
        })
        for (const model of providers.get(id)?.models.values() ?? []) {
          if (!item.models.some((allowed) => allowed.id === model.id)) providers.models.remove(id, model.id)
        }
        for (const model of item.models) {
          providers.models.update(id, Model.ID.make(model.id), (current) => {
            current.name = model.id
            current.package = undefined
            current.headers = undefined
          })
        }
      }
    })

    yield* ctx.model.transform((models) => {
      for (const model of models.list()) {
        const provider = catalog.get(model.providerID)
        if (!provider?.models.some((item) => item.id === model.id)) {
          models.remove(model.providerID, model.id)
          continue
        }
        models.update(model.providerID, model.id, (current) => {
          current.package = undefined
          current.headers = undefined
          current.settings = Object.fromEntries(
            Object.entries(current.settings ?? {}).filter(
              ([key]) => !["apiKey", "key", "headers", "baseURL", "fetch"].includes(key),
            ),
          )
        })
      }
      const configured = models.default.get()
      if (
        policy.catalog.default &&
        (!configured || !catalog.get(configured.providerID)?.models.some((model) => model.id === configured.modelID))
      )
        models.default.set(
          Provider.ID.make(policy.catalog.default.providerID),
          Model.ID.make(policy.catalog.default.modelID),
        )
    })

    yield* ctx.session.hook("model.request", (event) => {
      const provider = catalog.get(event.model.providerID)
      if (!provider || !provider.models.some((model) => model.id === event.model.id))
        return Effect.die(new Error("Enterprise model is not configured"))
      if (event.baseURL !== provider.baseURL) return Effect.die(new Error("Enterprise provider endpoint changed"))
      const headers = new Headers(event.headers)
      for (const [name, value] of Object.entries(Enterprise.requestHeaders(provider.id))) headers.set(name, value)
      event.headers = Object.fromEntries(headers)
      return Effect.void
    })

    yield* ctx.session.hook("http.request", (event) =>
      Effect.sync(() => {
        Enterprise.requireURL(event.request.url, policy.providerOrigins)
        event.request = new Request(event.request, { redirect: "manual" })
      }),
    )
    yield* ctx.session.hook("http.response", (event) =>
      [301, 302, 303, 307, 308].includes(event.response.status)
        ? Effect.die(new Error("Enterprise provider redirects are disabled"))
        : Effect.void,
    )
  }),
})
