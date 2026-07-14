import { afterEach, expect, test } from "bun:test"
import { ProviderEnterprise } from "@/provider/enterprise"
import { ProviderV2 } from "@opencode-ai/core/provider"

afterEach(() => ProviderEnterprise.setCredentials({ headers: {} }))

test("applies enterprise credentials only to the company provider", () => {
  ProviderEnterprise.setCredentials({
    apiKey: "secret-key",
    headers: { "X-Company-Token": "secret-header" },
  })
  expect(
    ProviderEnterprise.options(ProviderV2.ID.make("company-llm"), {
      baseURL: "https://llm.corp.example/v1",
      headers: { "X-Company-Token": "project-header", "X-Project": "preserved" },
    }),
  ).toEqual({
    baseURL: "https://llm.corp.example/v1",
    apiKey: "secret-key",
    headers: { "X-Company-Token": "secret-header", "X-Project": "preserved" },
  })
  expect(ProviderEnterprise.options(ProviderV2.ID.make("other"), {})).toEqual({})
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
