import { afterEach, expect, test } from "bun:test"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"

afterEach(() => ProviderEnterprise.setCredentials({ schemaVersion: 3, providers: {} }))

test("applies provider credentials to every model without crossing provider boundaries", () => {
  ProviderEnterprise.setCredentials({
    schemaVersion: 3,
    providers: {
      internal: {
        apiKey: "provider-key",
        headers: { Authorization: "provider-authorization", "x-company-token": "provider-header" },
      },
    },
  })

  const current = {
    headers: {
      authorization: "project-authorization",
      "X-COMPANY-Token": "project-header",
      "X-Project": "preserved",
    },
  }
  expect(ProviderEnterprise.options(ProviderV2.ID.make("internal"), "code", current)).toMatchObject({
    apiKey: "provider-key",
    headers: {
      Authorization: "provider-authorization",
      "x-company-token": "provider-header",
      "X-Project": "preserved",
    },
  })
  expect(ProviderEnterprise.options(ProviderV2.ID.make("internal"), "reasoning", {})).toMatchObject({
    apiKey: "provider-key",
    headers: { Authorization: "provider-authorization", "x-company-token": "provider-header" },
  })
  expect(ProviderEnterprise.options(ProviderV2.ID.make("other"), "code", {})).toEqual({ fetch: expect.any(Function) })
})

test("credential headers replace mixed-case project headers on the OpenAI-compatible request path", async () => {
  const request = Promise.withResolvers<Headers>()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(input) {
      request.resolve(input.headers)
      return Response.json({
        id: "chatcmpl-enterprise",
        object: "chat.completion",
        created: 0,
        model: "company-code",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  ProviderEnterprise.setCredentials({
    schemaVersion: 3,
    providers: {
      "company-llm": {
        headers: {
          Authorization: "Bearer credential-secret",
          "x-company-token": "credential-custom-secret",
        },
      },
    },
  })
  const options = ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), "company-code", {
    headers: {
      authorization: "Bearer project-secret",
      "X-COMPANY-Token": "project-custom-secret",
    },
  })
  const provider = createOpenAICompatible({
    name: "company-llm",
    baseURL: `${server.url}v1`,
    headers: options.headers as Record<string, string>,
    fetch: options.fetch as typeof fetch,
  })

  await generateText({ model: provider("company-code"), prompt: "hello" })

  const headers = await request.promise
  expect(headers.get("authorization")).toBe("Bearer credential-secret")
  expect(headers.get("x-company-token")).toBe("credential-custom-secret")
  expect(headers.get("authorization")).not.toContain("project-secret")
  expect(headers.get("x-company-token")).not.toContain("project-custom-secret")
  server.stop(true)
})

test("routes two providers to distinct URLs and credentials", async () => {
  const codeRequests: Headers[] = []
  const reasoningRequests: Headers[] = []
  const serve = (requests: Headers[]) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(input) {
        requests.push(input.headers)
        return Response.json({
          id: "chatcmpl-enterprise",
          object: "chat.completion",
          created: 0,
          model: "company-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
  using codeServer = serve(codeRequests)
  using reasoningServer = serve(reasoningRequests)
  ProviderEnterprise.setCredentials({
    schemaVersion: 3,
    providers: {
      "code-provider": { apiKey: "code-key", headers: { "x-company-token": "code-header" } },
      "reasoning-provider": { apiKey: "reasoning-key", headers: { "x-company-token": "reasoning-header" } },
    },
  })
  const model = (providerID: string, modelID: string, baseURL: string) => {
    const options = ProviderEnterprise.options(ProviderV2.ID.make(providerID), modelID, {})
    return createOpenAICompatible({
      name: providerID,
      baseURL,
      apiKey: options.apiKey as string,
      headers: options.headers as Record<string, string>,
      fetch: options.fetch as typeof fetch,
    })(modelID)
  }

  await Promise.all([
    generateText({ model: model("code-provider", "code", `${codeServer.url}v1`), prompt: "hello" }),
    generateText({ model: model("reasoning-provider", "reasoning", `${reasoningServer.url}v1`), prompt: "hello" }),
  ])

  expect(codeRequests).toHaveLength(1)
  expect(codeRequests[0].get("authorization")).toBe("Bearer code-key")
  expect(codeRequests[0].get("x-company-token")).toBe("code-header")
  expect(reasoningRequests).toHaveLength(1)
  expect(reasoningRequests[0].get("authorization")).toBe("Bearer reasoning-key")
  expect(reasoningRequests[0].get("x-company-token")).toBe("reasoning-header")
  codeServer.stop(true)
  reasoningServer.stop(true)
})

test("rejects enterprise provider redirects without contacting the redirect target", async () => {
  let redirected = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(input) {
      if (new URL(input.url).pathname === "/redirected") {
        redirected++
        return new Response("unexpected")
      }
      return Response.redirect(new URL("/redirected", input.url), 302)
    },
  })
  const options = ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), "company-code", {})

  await expect((options.fetch as typeof fetch)(`${server.url}v1`)).rejects.toThrow(
    "Enterprise provider redirects are disabled",
  )
  expect(redirected).toBe(0)
  expect(ProviderEnterprise.options(ProviderV2.ID.make("other"), "company-code", {})).toEqual({
    fetch: expect.any(Function),
  })
  server.stop(true)
})

test("invalid enterprise credentials are discarded without exposing prior values", () => {
  ProviderEnterprise.setCredentials({
    schemaVersion: 3,
    providers: { "company-llm": { apiKey: "secret-key", headers: { Authorization: "secret-header" } } },
  })
  ProviderEnterprise.setCredentials({ apiKey: 42, headers: { Authorization: false } })

  expect(
    ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), "code", {
      baseURL: "https://llm.corp.example/v1",
    }),
  ).toEqual({ baseURL: "https://llm.corp.example/v1" })
})
