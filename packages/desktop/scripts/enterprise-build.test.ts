import { expect, test } from "bun:test"

import { enterprisePackageEnvironment, validateEnterpriseBuild } from "./enterprise-build"

const valid = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "chai-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example",
}

const nonEmptyCatalog = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
    { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
    { id: "reasoning", name: "Company Reasoning", baseURL: "https://reasoning.corp.example/v1" },
  ]),
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "chai-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm-dr.corp.example",
}

const multiModel = {
  ...nonEmptyCatalog,
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "code",
}

const emptyCatalog = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: "[]",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "dev-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "dev-1",
}

test("accepts an empty Enterprise catalog", () => {
  expect(validateEnterpriseBuild(emptyCatalog)).toEqual({
    models: [],
    defaultModelID: "",
    defaultsVersion: "dev-1",
    guideVersion: "pilot-1",
    catalogVersion: "dev-1",
    allowedOrigins: [],
  })
})

test("rejects mixed empty-catalog package default states", () => {
  expect(() => validateEnterpriseBuild({ ...emptyCatalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "ghost" })).toThrow(
    "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
  )
  expect(() => validateEnterpriseBuild({ ...multiModel, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "" })).toThrow(
    "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
  )
})

test.each([
  ["empty catalog with omitted default", emptyCatalog, undefined, ""],
  ["empty catalog with empty default", emptyCatalog, "", ""],
  ["empty catalog with whitespace-only default", emptyCatalog, " \t ", ""],
  ["non-empty catalog with valid default", nonEmptyCatalog, "code", "code"],
])("package default matrix accepts %s", (_name, catalog, defaultModelID, expectedDefaultModelID) => {
  const metadata = validateEnterpriseBuild(
    defaultModelID === undefined
      ? catalog
      : { ...catalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: defaultModelID },
  )

  expect(metadata.defaultModelID).toBe(expectedDefaultModelID)
})

test.each([
  ["empty catalog with nonblank default", emptyCatalog, "ghost"],
  ["non-empty catalog with omitted default", nonEmptyCatalog, undefined],
  ["non-empty catalog with empty default", nonEmptyCatalog, ""],
  ["non-empty catalog with whitespace-only default", nonEmptyCatalog, " \t "],
])("package default matrix rejects %s", (_name, catalog, defaultModelID) => {
  expect(() =>
    validateEnterpriseBuild(
      defaultModelID === undefined
        ? catalog
        : { ...catalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: defaultModelID },
    ),
  ).toThrow("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
})

test("validates normalized multi-model build metadata", () => {
  expect(validateEnterpriseBuild(multiModel)).toEqual({
    models: [
      { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
      { id: "reasoning", name: "Company Reasoning", baseURL: "https://reasoning.corp.example/v1" },
    ],
    defaultModelID: "code",
    defaultsVersion: "pilot-1",
    guideVersion: "chai-1",
    catalogVersion: "catalog-1",
    allowedOrigins: [
      "https://code.corp.example",
      "https://reasoning.corp.example",
      "https://llm-dr.corp.example",
    ],
  })
})

test("rejects duplicate, secret-bearing, and incomplete model catalogs", () => {
  expect(() => validateEnterpriseBuild({ ...multiModel, OPENCODE_ENTERPRISE_MODELS: "not-json" })).toThrow(
    "OPENCODE_ENTERPRISE_MODELS",
  )
  expect(() =>
    validateEnterpriseBuild({
      ...multiModel,
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
        { id: "code", name: "Duplicate", baseURL: "https://other.corp.example/v1" },
      ]),
    }),
  ).toThrow("OPENCODE_ENTERPRISE_MODELS")
  expect(() =>
    validateEnterpriseBuild({
      ...multiModel,
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1", apiKey: "secret" },
      ]),
    }),
  ).toThrow("OPENCODE_ENTERPRISE_MODELS")
  expect(() =>
    validateEnterpriseBuild({ ...multiModel, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "missing" }),
  ).toThrow("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
})

test("accepts a portable unsigned profile without signing inputs", () => {
  expect(validateEnterpriseBuild(valid)).toMatchObject({
    models: [{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }],
    defaultModelID: "company-code",
    allowedOrigins: ["https://llm.corp.example"],
  })
})

test("returns only normalized non-secret enterprise build metadata", () => {
  expect(
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: "  HTTPS://LLM.CORP.EXAMPLE:443/v2  ",
      OPENCODE_ENTERPRISE_MODEL_ID: "  company-code  ",
      OPENCODE_ENTERPRISE_MODEL_NAME: "  Company Code  ",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "  pilot-1  ",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "  guide-1  ",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "  catalog-1  ",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS:
        "  https://LLM.corp.example:443/, http://localhost:3000/, https://llm.corp.example  ",
      OPENAI_API_KEY: "set",
      OPENCODE_ENTERPRISE_SECRET_HEADERS: "set",
    }),
  ).toEqual({
    models: [{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v2" }],
    defaultModelID: "company-code",
    defaultsVersion: "pilot-1",
    guideVersion: "guide-1",
    catalogVersion: "catalog-1",
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
    "OPENCODE_ENTERPRISE_CATALOG_VERSION",
  ]) {
    expect(() => validateEnterpriseBuild({ ...valid, [key]: " \t " })).toThrow(key)
  }
})

test.each([
  "https://llm.corp.example/v1\\..\\admin",
  "https://llm.corp.example/v1/%2e\t%2e/admin",
  "https://llm.corp.example/v1/.\n./admin",
])("rejects control and backslash URL normalization: %s", (baseURL) => {
  expect(() => validateEnterpriseBuild({ ...valid, OPENCODE_ENTERPRISE_BASE_URL: baseURL })).toThrow(
    "absolute HTTP(S) URL",
  )
})

test.each(["http://0x7f000001/v1", "http://0x7f.0.0.1/v1"])("rejects legacy IPv4 notation: %s", (baseURL) => {
  expect(() =>
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_BASE_URL: baseURL,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "http://127.0.0.1",
    }),
  ).toThrow("absolute HTTP(S) URL")
})

test("strips inherited signing variables from package children", () => {
  const env = enterprisePackageEnvironment({
    ...valid,
    CSC_LINK: "secret-path",
    CSC_KEY_PASSWORD: "secret-password",
    WIN_CSC_LINK: "alternate-secret",
    cSc_Mixed_Case: "case-insensitive-secret-marker",
    PATH: "preserve-me",
  })

  expect(env.PATH).toBe("preserve-me")
  expect(
    Object.keys(env).filter((key) => {
      const upper = key.toUpperCase()
      return upper.startsWith("CSC_") || upper.startsWith("WIN_CSC_")
    }),
  ).toEqual([])
})

test("automatically includes model origins before additional origins", () => {
  expect(
    validateEnterpriseBuild({
      ...valid,
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://other.corp.example",
    }).allowedOrigins,
  ).toEqual(["https://llm.corp.example", "https://other.corp.example"])
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

    expect(metadata.models[0].baseURL).toBe(normalizedBase)
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
