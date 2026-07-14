import { describe, expect, test } from "bun:test"
import { enterpriseEnvironment, parseEnterpriseProfile } from "./enterprise"

describe("enterprise profile", () => {
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
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
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

    expect(() => parseEnterpriseProfile({ ...env, OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1" })).toThrow(
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
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
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
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
      }),
    ).toThrow("must not contain credentials")
  })

  test("injects non-overridable offline flags and packaged paths", () => {
    const profile = parseEnterpriseProfile({
      OPENCODE_ENTERPRISE: "1",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example,https://llm-dr.corp.example",
    })

    expect(
      enterpriseEnvironment(profile, {
        defaults: "C:/app/enterprise/opencode.jsonc",
        guide: "C:/app/enterprise/company-guide.md",
      }),
    ).toEqual({
      OPENCODE_ENTERPRISE_OFFLINE: "1",
      OPENCODE_ENTERPRISE_DEFAULTS_PATH: "C:/app/enterprise/opencode.jsonc",
      OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_GUIDE_PATH: "C:/app/enterprise/company-guide.md",
      OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
      OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: "https://llm.corp.example,https://llm-dr.corp.example",
      OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
      OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
      OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    })
  })
})
