import { describe, expect, test } from "bun:test"
import {
  createEnterpriseRendererNetwork,
  desktopNotificationOptions,
  enterpriseEnvironment,
  enterpriseRendererRequestAllowed,
  enterpriseURLAllowed,
  parseEnterpriseProfile,
} from "./enterprise"

function enabledProfile() {
  return parseEnterpriseProfile({
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
    OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
    OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
    OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
    OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm-dr.corp.example",
  })
}

const emptyCatalog = {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_MODELS: "[]",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "dev-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "dev-1",
}

const nonEmptyCatalog = {
  ...emptyCatalog,
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
    { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
  ]),
}

describe("enterprise profile", () => {
  test("accepts an explicit empty Enterprise catalog", () => {
    const profile = parseEnterpriseProfile({
      ...emptyCatalog,
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
    })

    expect(profile).toMatchObject({ enabled: true, models: [], defaultModelID: "", allowedOrigins: [] })
    expect(enterpriseEnvironment(profile, { defaults: "C:/defaults", guide: "C:/guide" })).toMatchObject({
      OPENCODE_ENTERPRISE_MODELS: "[]",
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "",
    })
  })

  test("rejects mixed empty-catalog default states", () => {
    expect(() =>
      parseEnterpriseProfile({ ...emptyCatalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "ghost" }),
    ).toThrow(
      "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
    )
    expect(() => parseEnterpriseProfile({ ...nonEmptyCatalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "" })).toThrow(
      "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID",
    )
  })

  test.each([
    ["empty catalog with omitted default", emptyCatalog, undefined, ""],
    ["empty catalog with empty default", emptyCatalog, "", ""],
    ["empty catalog with whitespace-only default", emptyCatalog, " \t ", ""],
    ["non-empty catalog with valid default", nonEmptyCatalog, "code", "code"],
  ])("default matrix accepts %s", (_name, catalog, defaultModelID, expectedDefaultModelID) => {
    const profile = parseEnterpriseProfile(
      defaultModelID === undefined
        ? catalog
        : { ...catalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: defaultModelID },
    )

    expect(profile).toMatchObject({ enabled: true, defaultModelID: expectedDefaultModelID })
  })

  test.each([
    ["empty catalog with nonblank default", emptyCatalog, "ghost"],
    ["non-empty catalog with omitted default", nonEmptyCatalog, undefined],
    ["non-empty catalog with empty default", nonEmptyCatalog, ""],
    ["non-empty catalog with whitespace-only default", nonEmptyCatalog, " \t "],
  ])("default matrix rejects %s", (_name, catalog, defaultModelID) => {
    expect(() =>
      parseEnterpriseProfile(
        defaultModelID === undefined
          ? catalog
          : { ...catalog, OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: defaultModelID },
      ),
    ).toThrow("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
  })

  test("parses multiple models and derives the allowed origins", () => {
    const profile = parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
        { id: "reasoning", name: "Company Reasoning", baseURL: "https://reasoning.corp.example/v1" },
      ]),
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm-dr.corp.example",
    })

    expect(profile).toEqual({
      enabled: true,
      models: [
        { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
        { id: "reasoning", name: "Company Reasoning", baseURL: "https://reasoning.corp.example/v1" },
      ],
      defaultModelID: "code",
      defaultsVersion: "pilot-1",
      guideVersion: "kernexa-1",
      catalogVersion: "catalog-1",
      allowedOrigins: ["https://code.corp.example", "https://reasoning.corp.example", "https://llm-dr.corp.example"],
    })
  })

  test("rejects invalid multi-model catalogs", () => {
    const env = {
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
    }

    for (const models of [
      [{ id: "code", name: "Company Code", baseURL: "file:///private" }],
      [{ id: "code", name: "Company Code", baseURL: "https://user:secret@code.corp.example/v1" }],
      [{ id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1?secret=value" }],
      [
        { id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1" },
        { id: "code", name: "Duplicate", baseURL: "https://other.corp.example/v1" },
      ],
      [{ id: "code", name: "Company Code", baseURL: "https://code.corp.example/v1", token: "secret" }],
    ]) {
      expect(() => parseEnterpriseProfile({ ...env, OPENCODE_ENTERPRISE_MODELS: JSON.stringify(models) })).toThrow(
        "OPENCODE_ENTERPRISE_MODELS",
      )
    }

    expect(() =>
      parseEnterpriseProfile({
        ...env,
        OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
          { id: "reasoning", name: "Company Reasoning", baseURL: "https://reasoning.corp.example/v1" },
        ]),
      }),
    ).toThrow("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
  })

  test("converts legacy single-model settings for one release", () => {
    const profile = parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
    })

    expect(profile).toMatchObject({
      models: [{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }],
      defaultModelID: "company-code",
      allowedOrigins: ["https://llm.corp.example"],
    })
  })

  test("keeps ordinary builds disabled", () => {
    expect(parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" })).toEqual({ enabled: false })
    expect(enterpriseEnvironment({ enabled: false }, { defaults: "", guide: "" })).toEqual({})
  })

  test("requires valid internal model settings", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "not-a-url",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      }),
    ).toThrow("OPENCODE_ENTERPRISE_BASE_URL")
  })

  test("requires defaults and guide versions", () => {
    const env = {
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    }

    expect(() => parseEnterpriseProfile({ ...env, OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1" })).toThrow(
      "OPENCODE_ENTERPRISE_DEFAULTS_VERSION",
    )
    expect(() => parseEnterpriseProfile({ ...env, OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1" })).toThrow(
      "OPENCODE_ENTERPRISE_GUIDE_VERSION",
    )
  })

  test("rejects non-HTTP allowed origins", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
        OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "file:///C:/tmp",
      }),
    ).toThrow("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
  })

  test("rejects credentials embedded in the provider URL", () => {
    expect(() =>
      parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_BASE_URL: "https://user:secret@llm.corp.example/v1",
        OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      }),
    ).toThrow("must not contain credentials")
  })

  test("injects non-overridable offline flags and packaged paths", () => {
    const profile = parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
      ]),
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm-dr.corp.example",
    })

    expect(
      enterpriseEnvironment(profile, {
        defaults: "C:/app/enterprise/opencode.jsonc",
        guide: "C:/app/enterprise/company-guide.md",
        ripgrep: "C:/app/enterprise/ripgrep/rg.exe",
        userData: "C:/Users/person/AppData/Local/company-opencode",
        skillPacks: ["C:/app/enterprise/skill-packs/analyze-codebase/skills"],
      }),
    ).toEqual({
      OPENCODE_ENTERPRISE_OFFLINE: "1",
      OPENCODE_ENTERPRISE_DEFAULTS_PATH: "C:/app/enterprise/opencode.jsonc",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_PATH: "C:/app/enterprise/company-guide.md",
      OPENCODE_RIPGREP_PATH: "C:/app/enterprise/ripgrep/rg.exe",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
      OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS:
        "https://llm.corp.example,https://fast.corp.example,https://llm-dr.corp.example",
      OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
        { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
      ]),
      OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
      XDG_DATA_HOME: "C:/Users/person/AppData/Local/company-opencode/data",
      XDG_CONFIG_HOME: "C:/Users/person/AppData/Local/company-opencode/config",
      XDG_CACHE_HOME: "C:/Users/person/AppData/Local/company-opencode/cache",
      XDG_STATE_HOME: "C:/Users/person/AppData/Local/company-opencode/state",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_ENTERPRISE_SKILL_PATHS: JSON.stringify([
        "C:/app/enterprise/skill-packs/analyze-codebase/skills",
      ]),
    })
  })
})

describe("enterprise URL policy", () => {
  test("keeps disabled builds as an exact pass-through", () => {
    const profile = parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" })

    expect(enterpriseURLAllowed(profile, "not an absolute URL?secret=ordinary")).toBe(true)
    expect(enterpriseURLAllowed(profile, "file:///Users/person/private.txt")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "javascript:alert(1)")).toBe(true)
  })

  test("allows exact loopback hosts and configured provider origins", () => {
    const profile = enabledProfile()

    expect(enterpriseURLAllowed(profile, "http://127.0.0.1:4096/global/health")).toBe(true)
    expect(enterpriseURLAllowed(profile, "http://localhost:4096/global/health")).toBe(true)
    expect(enterpriseURLAllowed(profile, "http://[::1]:4096/global/health")).toBe(true)
    expect(enterpriseURLAllowed(profile, "https://llm.corp.example/v1/chat/completions")).toBe(true)
    expect(enterpriseURLAllowed(profile, new URL("https://llm-dr.corp.example/models"))).toBe(true)
  })

  test("denies credentialed, deceptive, mismatched, malformed, and non-HTTP URLs", () => {
    const profile = enabledProfile()

    expect(enterpriseURLAllowed(profile, "http://user:secret@localhost:4096/private")).toBe(false)
    expect(enterpriseURLAllowed(profile, "https://user:secret@llm.corp.example/v1")).toBe(false)
    expect(enterpriseURLAllowed(profile, "https://llm.corp.example.evil.test/v1")).toBe(false)
    expect(enterpriseURLAllowed(profile, "https://localhost.evil.test:4096")).toBe(false)
    expect(enterpriseURLAllowed(profile, "https://llm.corp.example:444/v1")).toBe(false)
    expect(enterpriseURLAllowed(profile, "https://opencode.ai/changelog.json")).toBe(false)
    expect(enterpriseURLAllowed(profile, "file:///Users/person/private.txt")).toBe(false)
    expect(enterpriseURLAllowed(profile, "javascript:alert(1)")).toBe(false)
    expect(enterpriseURLAllowed(profile, "not an absolute URL?secret=company")).toBe(false)
  })

  test("allows renderer-owned schemes only at the Electron session boundary", () => {
    const profile = enabledProfile()

    expect(enterpriseRendererRequestAllowed(profile, "opencode://app/index.html")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "oc://renderer/index.html")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "data:image/png;base64,AA==")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "blob:https://llm.corp.example/asset-id")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "https://llm.corp.example/app.css")).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "opencode://user:secret@app/index.html")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "opencode://public/index.html")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "oc://renderer.evil.test/index.html")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "https://cdn.example/image.png")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "file:///Users/person/private.css")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "javascript:alert(1)")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "not a renderer URL")).toBe(false)
  })

  test("allows only websocket requests paired with the same loopback development renderer", () => {
    const profile = enabledProfile()

    expect(
      enterpriseRendererRequestAllowed(profile, "ws://localhost:5173/@vite/client", "http://localhost:5173/index.html"),
    ).toBe(true)
    expect(
      enterpriseRendererRequestAllowed(profile, "wss://[::1]:8443/hmr", "https://[::1]:8443/nested/index.html"),
    ).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "ws://LOCALHOST:80/hmr", "http://localhost/index.html")).toBe(true)
  })

  test("allows only authenticated loopback PTY websockets outside development", () => {
    const profile = enabledProfile()

    expect(
      enterpriseRendererRequestAllowed(
        profile,
        "ws://127.0.0.1:4096/pty/pty_test/connect?directory=C%3A%2Fproject&cursor=0&ticket=one-time",
      ),
    ).toBe(true)
    expect(
      enterpriseRendererRequestAllowed(
        profile,
        "ws://localhost:4096/pty/pty_test/connect?directory=C%3A%2Fproject&cursor=0&auth_token=encoded",
      ),
    ).toBe(true)
    expect(enterpriseRendererRequestAllowed(profile, "ws://localhost:4096/pty/pty_test/connect")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "ws://localhost:4096/events?ticket=one-time")).toBe(false)
    expect(
      enterpriseRendererRequestAllowed(profile, "ws://external.example/pty/pty_test/connect?ticket=one-time"),
    ).toBe(false)
  })

  test("denies websocket requests that are not the exact development renderer endpoint", () => {
    const profile = enabledProfile()

    expect(enterpriseRendererRequestAllowed(profile, "ws://localhost:5174/hmr", "http://localhost:5173")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "ws://127.0.0.1:5173/hmr", "http://localhost:5173")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "ws://localhost:5173/hmr", "https://localhost:5173")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "wss://localhost:5173/hmr", "http://localhost:5173")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "wss://llm.corp.example/hmr", "https://llm.corp.example")).toBe(
      false,
    )
    expect(enterpriseRendererRequestAllowed(profile, "ws://localhost:5173/hmr", "not a renderer URL")).toBe(false)
    expect(enterpriseRendererRequestAllowed(profile, "not a websocket URL", "http://localhost:5173")).toBe(false)
    expect(
      enterpriseRendererRequestAllowed(profile, "ws://user:secret@localhost:5173/hmr", "http://localhost:5173"),
    ).toBe(false)
    expect(
      enterpriseRendererRequestAllowed(profile, "ws://localhost:5173/hmr", "http://user:secret@localhost:5173"),
    ).toBe(false)
  })
})

describe("enterprise renderer network boundary", () => {
  test("rejects links before IPC while preserving ordinary behavior", () => {
    const enterpriseCalls: string[] = []
    const ordinaryCalls: string[] = []
    const fetcher = (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch
    const enterprise = createEnterpriseRendererNetwork(enabledProfile(), {
      openLink: (url) => enterpriseCalls.push(url),
      fetch: fetcher,
    })
    const ordinary = createEnterpriseRendererNetwork(parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" }), {
      openLink: (url) => ordinaryCalls.push(url),
      fetch: fetcher,
    })

    enterprise.openLink("https://opencode.ai/docs?token=company")
    enterprise.openLink("https://llm.corp.example/docs")
    enterprise.openLink("not a URL?token=company")
    ordinary.openLink("https://opencode.ai/docs?token=ordinary")
    ordinary.openLink("not a URL?token=ordinary")

    expect(enterpriseCalls).toEqual(["https://llm.corp.example/docs"])
    expect(ordinaryCalls).toEqual(["https://opencode.ai/docs?token=ordinary", "not a URL?token=ordinary"])
  })

  test("forwards allowed string, URL, and Request inputs without changing fetch semantics", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const network = createEnterpriseRendererNetwork(enabledProfile(), {
      openLink: () => undefined,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return Promise.resolve(new Response(null, { status: 204 }))
      }) as typeof fetch,
    })
    const url = new URL("https://llm.corp.example/v1/models")
    const request = new Request("http://127.0.0.1:4096/global/health")

    await network.fetch("http://localhost:4096/global/health", { headers: { Accept: "application/json" } })
    await network.fetch(url, { method: "POST" })
    await network.fetch(request, { method: "DELETE" })

    expect(calls).toEqual([
      {
        input: "http://localhost:4096/global/health",
        init: { headers: { Accept: "application/json" } },
      },
      { input: url, init: { method: "POST" } },
      { input: request, init: undefined },
    ])
  })

  test("keeps disabled fetch behavior as a pass-through", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const network = createEnterpriseRendererNetwork(parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" }), {
      openLink: () => undefined,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return Promise.resolve(new Response(null, { status: 204 }))
      }) as typeof fetch,
    })
    const request = new Request("https://opencode.ai/changelog.json")

    await network.fetch("not an absolute URL?token=ordinary", { method: "POST" })
    await network.fetch(request, { method: "DELETE" })

    expect(calls).toEqual([
      { input: "not an absolute URL?token=ordinary", init: { method: "POST" } },
      { input: request, init: undefined },
    ])
  })

  test("rejects disallowed string, URL, Request, and non-HTTP inputs without leaking secrets", async () => {
    const calls: Array<RequestInfo | URL> = []
    const network = createEnterpriseRendererNetwork(enabledProfile(), {
      openLink: () => undefined,
      fetch: ((input: RequestInfo | URL) => {
        calls.push(input)
        return Promise.resolve(new Response(null, { status: 204 }))
      }) as typeof fetch,
    })
    const urlFailure = await network
      .fetch(new URL("https://cdn.example/private.png?token=url-secret"))
      .catch((error: unknown) => error)
    const requestFailure = await network
      .fetch(new Request("https://opencode.ai/changelog.json?token=request-secret"))
      .catch((error: unknown) => error)
    const fileFailure = await network
      .fetch("file:///Users/person/private.txt?token=file-secret")
      .catch((error: unknown) => error)
    const malformedFailure = await network.fetch("not a URL?token=malformed-secret").catch((error: unknown) => error)

    expect(urlFailure).toEqual(new Error("Enterprise offline policy blocked https://cdn.example"))
    expect(requestFailure).toEqual(new Error("Enterprise offline policy blocked https://opencode.ai"))
    expect(fileFailure).toEqual(new Error("Enterprise offline policy blocked null"))
    expect(malformedFailure).toEqual(new Error("Enterprise offline policy blocked <invalid>"))
    expect(JSON.stringify([urlFailure, requestFailure, fileFailure, malformedFailure])).not.toContain("secret")
    expect(calls).toEqual([])
  })

  test("omits notification icons in enterprise and keeps the packaged icon publicly", () => {
    expect(desktopNotificationOptions(enabledProfile(), "Finished", "oc://renderer/index.html")).toEqual({
      body: "Finished",
    })
    expect(
      desktopNotificationOptions(
        parseEnterpriseProfile({ OPENCODE_ENTERPRISE: "0" }),
        "Finished",
        "oc://renderer/index.html",
      ),
    ).toEqual({
      body: "Finished",
      icon: "oc://renderer/favicon-96x96-v3.png",
    })
  })
})
