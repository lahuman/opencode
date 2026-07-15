import { isIP } from "node:net"

type Env = Record<string, string | undefined>

export type EnterpriseBuildMetadata = {
  baseURL: string
  modelID: string
  modelName: string
  defaultsVersion: string
  guideVersion: string
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

  const baseURL = requireValue(env, "OPENCODE_ENTERPRISE_BASE_URL")
  if (/[?#]/.test(baseURL)) {
    throw new Error("OPENCODE_ENTERPRISE_BASE_URL must not contain a query or fragment")
  }
  const rawBase = parseRawHTTPURL(
    baseURL,
    "OPENCODE_ENTERPRISE_BASE_URL",
    "OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL",
  )
  if (hasDotPathSegment(rawBase.remainder)) {
    throw new Error("OPENCODE_ENTERPRISE_BASE_URL must not contain dot path segments")
  }
  const base = createHTTPURL(baseURL, rawBase.host, "OPENCODE_ENTERPRISE_BASE_URL must be an absolute HTTP(S) URL")
  const allowedOrigins = Array.from(
    new Set(
      requireValue(env, "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => parseAllowedOrigin(value).origin),
    ),
  )

  if (!allowedOrigins.includes(base.origin)) {
    throw new Error("OPENCODE_ENTERPRISE_ALLOWED_ORIGINS must include the OPENCODE_ENTERPRISE_BASE_URL origin")
  }

  return {
    baseURL: base.href,
    modelID: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_ID"),
    modelName: requireValue(env, "OPENCODE_ENTERPRISE_MODEL_NAME"),
    defaultsVersion: requireValue(env, "OPENCODE_ENTERPRISE_DEFAULTS_VERSION"),
    guideVersion: requireValue(env, "OPENCODE_ENTERPRISE_GUIDE_VERSION"),
    allowedOrigins,
  }
}

function requireValue(env: Env, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required for an enterprise Windows package`)
  return value
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
