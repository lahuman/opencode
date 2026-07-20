import { isIP } from "node:net"

type Env = Record<string, string | undefined>

export type EnterpriseBuildMetadata = {
  models: { id: string; name: string; baseURL: string }[]
  defaultModelID: string
  defaultsVersion: string
  guideVersion: string
  catalogVersion: string
  allowedOrigins: string[]
}

export function enterprisePackageEnvironment(env: Env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const upper = key.toUpperCase()
      return !upper.startsWith("CSC_") && !upper.startsWith("WIN_CSC_")
    }),
  )
}

export function validateEnterpriseBuild(env: Env): EnterpriseBuildMetadata {
  if (env.OPENCODE_ENTERPRISE !== "1") throw new Error("OPENCODE_ENTERPRISE must be 1")

  const models = parseModels(env)
  const defaultModelID = env.OPENCODE_ENTERPRISE_MODELS
    ? models.length
      ? requireValue(env, "OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID")
      : env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID?.trim() ?? ""
    : models[0].id
  if (
    (models.length === 0 && defaultModelID) ||
    (models.length > 0 && !models.some((model) => model.id === defaultModelID))
  ) {
    throw new Error("OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID must reference a configured model")
  }
  const allowedOrigins = Array.from(
    new Set(
      [
        ...models.map((model) => new URL(model.baseURL).origin),
        ...(env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => parseAllowedOrigin(value).origin),
      ],
    ),
  )

  return {
    models,
    defaultModelID,
    defaultsVersion: requireValue(env, "OPENCODE_ENTERPRISE_DEFAULTS_VERSION"),
    guideVersion: requireValue(env, "OPENCODE_ENTERPRISE_GUIDE_VERSION"),
    catalogVersion: requireValue(env, "OPENCODE_ENTERPRISE_CATALOG_VERSION"),
    allowedOrigins,
  }
}

function parseModels(env: Env) {
  if (!env.OPENCODE_ENTERPRISE_MODELS) {
    return [
      {
        id: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_ID"),
        name: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_NAME"),
        baseURL: parseModelURL(requireValue(env, "OPENCODE_ENTERPRISE_BASE_URL"), "OPENCODE_ENTERPRISE_BASE_URL"),
      },
    ]
  }

  const value: unknown = (() => {
    try {
      return JSON.parse(env.OPENCODE_ENTERPRISE_MODELS)
    } catch {
      throw new Error("OPENCODE_ENTERPRISE_MODELS must be a JSON array")
    }
  })()
  if (!Array.isArray(value)) {
    throw new Error("OPENCODE_ENTERPRISE_MODELS must be a JSON array")
  }
  const models = value.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["baseURL", "id", "name"])) {
      throw new Error("OPENCODE_ENTERPRISE_MODELS must contain only id, name, and baseURL")
    }
    const id = typeof item.id === "string" ? item.id.trim() : ""
    const name = typeof item.name === "string" ? item.name.trim() : ""
    const baseURL = typeof item.baseURL === "string" ? item.baseURL.trim() : ""
    if (!id || !name || !baseURL) throw new Error("OPENCODE_ENTERPRISE_MODELS contains incomplete model metadata")
    return { id, name, baseURL: parseModelURL(baseURL, "OPENCODE_ENTERPRISE_MODELS") }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("OPENCODE_ENTERPRISE_MODELS must contain unique model IDs")
  }
  return models
}

function parseModelURL(value: string, key: string) {
  const legacy = key === "OPENCODE_ENTERPRISE_BASE_URL"
  if (/[?#]/.test(value)) {
    throw new Error(legacy ? `${key} must not contain a query or fragment` : `${key} model URLs must not contain a query or fragment`)
  }
  const invalid = legacy ? `${key} must be an absolute HTTP(S) URL` : `${key} model URLs must be absolute HTTP(S) URLs`
  const raw = parseRawHTTPURL(value, key, invalid)
  if (hasDotPathSegment(raw.remainder)) {
    throw new Error(legacy ? `${key} must not contain dot path segments` : `${key} model URLs must not contain dot path segments`)
  }
  return createHTTPURL(value, raw.host, invalid).href
}

function requireValue(env: Env, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required for enterprise mode`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = keys.sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseAllowedOrigin(value: string) {
  const invalid = "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only absolute HTTP(S) URLs"
  const raw = parseRawHTTPURL(value, "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS", invalid)
  if (raw.remainder !== "" && raw.remainder !== "/") {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must contain only HTTP(S) origins")
  }
  return createHTTPURL(value, raw.host, invalid)
}

function parseRawHTTPURL(value: string, key: string, invalid: string) {
  const scheme = /^(?:https?):\/\//i.exec(value)
  if (!scheme) throw new Error(invalid)

  const remainder = value.slice(scheme[0].length)
  const delimiter = remainder.search(/[/?#]/)
  const authority = delimiter === -1 ? remainder : remainder.slice(0, delimiter)
  const suffix = delimiter === -1 ? "" : remainder.slice(delimiter)
  if (authority.includes("@")) throw new Error(`${key} must not contain credentials`)
  if (!authority || /[%\\\s]/.test(authority) || !isValidAuthority(authority)) throw new Error(invalid)
  return {
    host: authority.startsWith("[") ? authority.slice(1, authority.indexOf("]")) : authority.split(":")[0],
    remainder: suffix,
  }
}

function isValidAuthority(authority: string) {
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]")
    if (closing <= 1 || authority.indexOf("[", 1) !== -1 || authority.indexOf("]", closing + 1) !== -1) {
      return false
    }
    const suffix = authority.slice(closing + 1)
    if (suffix && !isValidPortSuffix(suffix)) return false
    return isIP(authority.slice(1, closing)) === 6
  }
  if (authority.includes("[") || authority.includes("]")) return false

  const parts = authority.split(":")
  if (parts.length > 2 || !isValidHost(parts[0])) return false
  if (parts.length === 2 && !isValidPort(parts[1])) return false
  return true
}

function isValidHost(host: string) {
  if (!host) return false
  if (isIP(host) === 4) return true
  if (/^[\d.]+$/.test(host)) return false
  return host
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

function isValidPortSuffix(value: string) {
  return value.startsWith(":") && isValidPort(value.slice(1))
}

function isValidPort(value: string) {
  return /^(?:0|[1-9]\d*)$/.test(value) && Number(value) <= 65535
}

function hasDotPathSegment(remainder: string) {
  return remainder.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
}

function createHTTPURL(value: string, rawHost: string, invalid: string) {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || !URL.canParse(value)) throw new Error(invalid)
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(invalid)
  if (isIP(url.hostname) === 4 && isIP(rawHost) !== 4) throw new Error(invalid)
  return url
}
