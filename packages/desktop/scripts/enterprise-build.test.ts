import { expect, test } from "bun:test"

import { validateEnterpriseBuild } from "./enterprise-build"

const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
  CSC_LINK: "set",
  CSC_KEY_PASSWORD: "set",
}

test("returns only normalized non-secret enterprise build metadata", () => {
  expect(
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: "  HTTPS://LLM.CORP.EXAMPLE:443/v1/../v2  ",
      OPENCODE_ENTERPRISE_MODEL_ID: "  company-code  ",
      OPENCODE_ENTERPRISE_MODEL_NAME: "  Company Code  ",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "  pilot-1  ",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "  guide-1  ",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "  https://LLM.corp.example:443/path, http://localhost:3000/ignored  ",
      OPENAI_API_KEY: "set",
      OPENCODE_ENTERPRISE_SECRET_HEADERS: "set",
    }),
  ).toEqual({
    baseURL: "https://llm.corp.example/v2",
    modelID: "company-code",
    modelName: "Company Code",
    defaultsVersion: "pilot-1",
    guideVersion: "guide-1",
    allowedOrigins: ["https://llm.corp.example", "http://localhost:3000"],
  })
})

test("requires enterprise mode and every enterprise package input", () => {
  expect(() => validateEnterpriseBuild({ ...valid, OPENCODE_ENTERPRISE: "0" })).toThrow("OPENCODE_ENTERPRISE")

  for (const key of [
    "OPENCODE_ENTERPRISE_BASE_URL",
    "OPENCODE_ENTERPRISE_MODEL_ID",
    "OPENCODE_ENTERPRISE_MODEL_NAME",
    "OPENCODE_ENTERPRISE_DEFAULTS_VERSION",
    "OPENCODE_ENTERPRISE_GUIDE_VERSION",
    "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
  ]) {
    expect(() => validateEnterpriseBuild({ ...valid, [key]: " \t " })).toThrow(key)
  }
})

test("requires the declared origins to include the base URL origin", () => {
  expect(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://other.corp.example",
    }),
  ).toThrow("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
})

test("rejects non-HTTP and credentialed base URLs with generic safe errors", () => {
  expect(
    errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_BASE_URL: "file:///internal/path",
      }),
    ),
  ).toBe("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")

  expect(
    errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_BASE_URL: "https://name:credential-marker@llm.corp.example/v1",
      }),
    ),
  ).toBe("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
})

test("rejects malformed base URLs without exposing parser input or native errors", () => {
  const message = errorMessage(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: "https://name:parser-marker@[",
    }),
  )

  expect(message).toBe("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
  expect(message).not.toContain("parser-marker")
  expect(message).not.toContain("Invalid URL")
})

test("rejects non-HTTP, credentialed, and malformed allowed origins with generic safe errors", () => {
  expect(
    errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example, file:///internal/path",
      }),
    ),
  ).toBe("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs")

  expect(
    errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://name:credential-marker@llm.corp.example",
      }),
    ),
  ).toBe("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")

  const message = errorMessage(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example, https://name:parser-marker@[/",
    }),
  )
  expect(message).toBe("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs")
  expect(message).not.toContain("parser-marker")
  expect(message).not.toContain("Invalid URL")
})

function errorMessage(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error.message
  }
  throw new Error("Expected enterprise build validation to fail")
}
