import { afterEach, beforeEach, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Enterprise } from "@opencode/core/enterprise"
import { EnterprisePlugin } from "@opencode/core/plugin/enterprise"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const names = [
  "OPENCODE_ENTERPRISE_OFFLINE",
  "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
  "OPENCODE_ENTERPRISE_PROVIDER_CATALOG",
] as const
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("company")
const modelID = Model.ID.make("company-model")

beforeEach(() => {
  process.env.OPENCODE_ENTERPRISE_OFFLINE = "1"
  process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = ""
  process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify({
    schemaVersion: 1,
    default: { providerID, modelID },
    providers: [
      {
        id: providerID,
        name: "Company",
        baseURL: "https://llm.internal/v1",
        models: [{ id: modelID, name: "Company Model" }],
      },
    ],
  })
})

afterEach(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  Enterprise.setCredentials({ schemaVersion: 3, providers: {} })
})

it.effect("restricts the actual provider/model catalogs after config transforms and reloads", () =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const plugin = yield* Plugin.Service
    yield* providers.transform((editor) => {
      editor.update(Provider.ID.openai, () => {})
      editor.update(providerID, (provider) => {
        provider.settings = { baseURL: "https://public.example", apiKey: "config-secret" }
      })
      editor.models.update(providerID, Model.ID.make("unapproved"), () => {})
    })
    yield* EnterprisePlugin.Plugin.effect(yield* PluginHost.make(plugin))
    yield* providers.reload()
    expect((yield* providers.all()).map((provider) => provider.id)).toEqual([providerID])
    expect((yield* providers.get(providerID))?.settings).toEqual({
      baseURL: "https://llm.internal/v1",
      provider: providerID,
    })
    expect((yield* models.available()).map((model) => model.id)).toEqual([modelID])
    expect((yield* models.default())?.id).toBe(modelID)
    expect(JSON.stringify(yield* models.all())).not.toContain("config-secret")
  }),
)

it.effect("adds private credentials only at request time and rejects endpoint changes and redirects", () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    Enterprise.setCredentials({
      schemaVersion: 3,
      providers: { company: { apiKey: "private-key", headers: { "X-Gateway": "private-header" } } },
    })
    yield* EnterprisePlugin.Plugin.effect(yield* PluginHost.make(plugin))
    const scope = {
      sessionID: Session.ID.create(),
      agent: Agent.ID.make("build"),
      model: { providerID, id: modelID },
      kind: "primary" as const,
    }
    const request = yield* hooks.trigger("session", "model.request", {
      ...scope,
      baseURL: "https://llm.internal/v1",
      headers: {},
    })
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer private-key")
    expect(new Headers(request.headers).get("x-gateway")).toBe("private-header")
    const changed = yield* hooks
      .trigger("session", "model.request", { ...scope, baseURL: "https://public.example", headers: {} })
      .pipe(Effect.exit)
    expect(Exit.isFailure(changed)).toBe(true)
    const outgoing = yield* hooks.trigger("session", "http.request", {
      ...scope,
      request: new Request("https://llm.internal/v1/chat/completions"),
    })
    expect(outgoing.request.redirect).toBe("manual")
    const unregistered = yield* hooks
      .trigger("session", "http.request", {
        ...scope,
        request: new Request("https://public.example/v1/chat/completions"),
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(unregistered)).toBe(true)
    const redirect = yield* hooks
      .trigger("session", "http.response", {
        ...scope,
        request: outgoing.request,
        response: new Response(null, { status: 302, headers: { location: "https://public.example" } }),
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(redirect)).toBe(true)
  }),
)
