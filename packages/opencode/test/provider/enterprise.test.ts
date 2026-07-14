import { afterEach, expect, test } from "bun:test"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"

afterEach(() => ProviderEnterprise.setCredentials({ headers: {} }))

test("applies enterprise credentials only to the company provider", () => {
  ProviderEnterprise.setCredentials({
    apiKey: "secret-key",
    headers: { Authorization: "secret-authorization", "x-company-token": "secret-header" },
  })
  expect(
    ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), {
      baseURL: "https://llm.corp.example/v1",
      headers: {
        authorization: "project-authorization",
        "X-COMPANY-Token": "project-header",
        "X-Project": "preserved",
      },
    }),
  ).toEqual({
    baseURL: "https://llm.corp.example/v1",
    apiKey: "secret-key",
    headers: {
      Authorization: "secret-authorization",
      "x-company-token": "secret-header",
      "X-Project": "preserved",
    },
  })
  expect(ProviderEnterprise.options(ProviderV2.ID.make("other"), {})).toEqual({})
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
    headers: {
      Authorization: "Bearer credential-secret",
      "x-company-token": "credential-custom-secret",
    },
  })
  const options = ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), {
    headers: {
      authorization: "Bearer project-secret",
      "X-COMPANY-Token": "project-custom-secret",
    },
  })
  const provider = createOpenAICompatible({
    name: "company-llm",
    baseURL: `${server.url}v1`,
    headers: options.headers as Record<string, string>,
  })

  await generateText({ model: provider("company-code"), prompt: "hello" })

  const headers = await request.promise
  expect(headers.get("authorization")).toBe("Bearer credential-secret")
  expect(headers.get("x-company-token")).toBe("credential-custom-secret")
  expect(headers.get("authorization")).not.toContain("project-secret")
  expect(headers.get("x-company-token")).not.toContain("project-custom-secret")
})

test("invalid enterprise credentials are discarded without exposing prior values", () => {
  ProviderEnterprise.setCredentials({ apiKey: "secret-key", headers: { Authorization: "secret-header" } })
  ProviderEnterprise.setCredentials({ apiKey: 42, headers: { Authorization: false } })

  expect(
    ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), {
      baseURL: "https://llm.corp.example/v1",
    }),
  ).toEqual({ baseURL: "https://llm.corp.example/v1" })
})
