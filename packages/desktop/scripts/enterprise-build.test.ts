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
      OPENCODE_ENTERPRISE_BASE_URL: "  HTTPS://LLM.CORP.EXAMPLE:443/v2  ",
      OPENCODE_ENTERPRISE_MODEL_ID: "  company-code  ",
      OPENCODE_ENTERPRISE_MODEL_NAME: "  Company Code  ",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "  pilot-1  ",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "  guide-1  ",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS:
        "  https://LLM.corp.example:443/, http://localhost:3000/, https://llm.corp.example  ",
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

test("rejects alternate electron-builder signing environment inputs without disclosing values", () => {
  for (const key of [
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "CSC_NAME",
    "CSC_INSTALLER_LINK",
    "CSC_INSTALLER_KEY_PASSWORD",
    "CSC_KEYCHAIN",
    "CSC_IDENTITY_AUTO_DISCOVERY",
    "CSC_FOR_PULL_REQUEST",
  ]) {
    const message = errorMessage(() => validateEnterpriseBuild({ ...valid, [key]: "alternate-signing-value" }))

    expect(message).toBe(`${key} is not supported for an enterprise Windows package`)
    expect(message).not.toContain("alternate-signing-value")
    expect(errorMessage(() => validateEnterpriseBuild({ ...valid, [key]: "" }))).toBe(
      `${key} is not supported for an enterprise Windows package`,
    )
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

  expect(message).toBe("OPENCODE_ENTERPRISE_BASE_URL must not contain credentials")
  expect(message).not.toContain("parser-marker")
  expect(message).not.toContain("Invalid URL")
})

test("rejects base URL query and fragment markers without returning or exposing them", () => {
  for (const baseURL of [
    "https://llm.corp.example/v1?api_key=query-secret-marker",
    "https://llm.corp.example/v1#fragment-secret-marker",
    "https://llm.corp.example/v1?",
    "https://llm.corp.example/v1#",
  ]) {
    const message = errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_BASE_URL: baseURL,
      }),
    )

    expect(message).toBe("OPENCODE_ENTERPRISE_BASE_URL must not contain a query or fragment")
    expect(message).not.toContain("query-secret-marker")
    expect(message).not.toContain("fragment-secret-marker")
  }
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
  expect(message).toBe("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials")
  expect(message).not.toContain("parser-marker")
  expect(message).not.toContain("Invalid URL")
})

test("rejects allowed-origin paths, queries, and fragments with fixed input-free errors", () => {
  for (const origin of [
    "https://llm.corp.example/v1/path-secret-marker",
    "https://llm.corp.example/segment/..",
    "https://llm.corp.example/%2e",
    "https://llm.corp.example/?key=query-secret-marker",
    "https://llm.corp.example/#fragment-secret-marker",
    "https://llm.corp.example?",
    "https://llm.corp.example#",
  ]) {
    const message = errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: origin,
      }),
    )

    expect(message).toBe("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins")
    expect(message).not.toContain("path-secret-marker")
    expect(message).not.toContain("query-secret-marker")
    expect(message).not.toContain("fragment-secret-marker")
  }
})

test("rejects exact deceptive matching-origin forms before URL normalization", () => {
  const cases = [
    ["https://:@llm.corp.example", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must not contain credentials"],
    ["https://%6c%6cm.corp.example", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs"],
    ["https://llm.corp.example:", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs"],
    ["https://llm.corp.example?", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins"],
    ["https://llm.corp.example#", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins"],
    ["https://llm.corp.example/segment/..", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins"],
    ["https://llm.corp.example/%2e", "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins"],
  ] as const

  for (const [origin, expected] of cases) {
    const message = errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: origin,
      }),
    )

    expect(message).toBe(expected)
    expect(message).not.toContain(origin)
  }
})

test("rejects deceptive base authorities and raw dot paths before normalization", () => {
  const cases = [
    ["https://:@llm.corp.example/v1", "OPENCODE_ENTERPRISE_BASE_URL must not contain credentials"],
    ["https://%6c%6cm.corp.example/v1", "OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL"],
    ["https://llm.corp.example:/v1", "OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL"],
    ["https://llm.corp.example/v1?", "OPENCODE_ENTERPRISE_BASE_URL must not contain a query or fragment"],
    ["https://llm.corp.example/v1#", "OPENCODE_ENTERPRISE_BASE_URL must not contain a query or fragment"],
    ["https://llm.corp.example/segment/..", "OPENCODE_ENTERPRISE_BASE_URL must not contain dot path segments"],
    ["https://llm.corp.example/%2e", "OPENCODE_ENTERPRISE_BASE_URL must not contain dot path segments"],
  ] as const

  for (const [baseURL, expected] of cases) {
    const message = errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_BASE_URL: baseURL,
      }),
    )

    expect(message).toBe(expected)
    expect(message).not.toContain(baseURL)
  }
})

test("rejects malformed raw authorities without parser diagnostics", () => {
  for (const baseURL of [
    "https://llm .corp.example/v1",
    "https://llm.corp.example\\deceptive/v1",
    "https://[2001:db8::1/v1",
    "https://llm.corp.example:000443/v1",
  ]) {
    const message = errorMessage(() => validateEnterpriseBuild({ ...valid, OPENCODE_ENTERPRISE_BASE_URL: baseURL }))

    expect(message).toBe("OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
    expect(message).not.toContain(baseURL)
    expect(message).not.toContain("Invalid URL")
  }
})

test("accepts strict DNS, numeric-port, and bracketed-IPv6 enterprise URLs", () => {
  for (const [baseURL, origin, normalizedBase, normalizedOrigin] of [
    [
      "https://llm.corp.example/v1",
      "https://llm.corp.example/",
      "https://llm.corp.example/v1",
      "https://llm.corp.example",
    ],
    [
      "https://llm.corp.example:8443/v1",
      "https://llm.corp.example:8443",
      "https://llm.corp.example:8443/v1",
      "https://llm.corp.example:8443",
    ],
    [
      "https://[2001:db8::1]:8443/v1",
      "https://[2001:db8::1]:8443/",
      "https://[2001:db8::1]:8443/v1",
      "https://[2001:db8::1]:8443",
    ],
  ]) {
    const metadata = validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: baseURL,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: origin,
    })

    expect(metadata.baseURL).toBe(normalizedBase)
    expect(metadata.allowedOrigins).toEqual([normalizedOrigin])
  }
})

test("rejects deceptive allowed-origin authorities before normalization", () => {
  for (const origin of [
    "https://llm.corp.example@deceptive.example",
    "https://llm.corp.example%2edeceptive.example",
    "https://llm.corp.example\\@deceptive.example",
  ]) {
    const message = errorMessage(() =>
      validateEnterpriseBuild({
        ...valid,
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: origin,
      }),
    )

    expect(message).toMatch(/^OPENCODE_ENTERPRISE_ALLOWED_ORIGINS /)
    expect(message).not.toContain("deceptive.example")
  }
})

function errorMessage(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error.message
  }
  throw new Error("Expected enterprise build validation to fail")
}
