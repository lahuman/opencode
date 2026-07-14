import { enterpriseEnvironment, parseEnterpriseProfile, type EnterpriseProfile } from "./enterprise-profile"

export { enterpriseEnvironment, parseEnterpriseProfile }
export type { EnterpriseProfile } from "./enterprise-profile"

export const ENTERPRISE_PROFILE = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: import.meta.env.OPENCODE_ENTERPRISE,
  OPENCODE_ENTERPRISE_BASE_URL: import.meta.env.OPENCODE_ENTERPRISE_BASE_URL,
  OPENCODE_ENTERPRISE_MODEL_ID: import.meta.env.OPENCODE_ENTERPRISE_MODEL_ID,
  OPENCODE_ENTERPRISE_MODEL_NAME: import.meta.env.OPENCODE_ENTERPRISE_MODEL_NAME,
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: import.meta.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION,
  OPENCODE_ENTERPRISE_GUIDE_VERSION: import.meta.env.OPENCODE_ENTERPRISE_GUIDE_VERSION,
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS,
})

export const ENTERPRISE_ENABLED = ENTERPRISE_PROFILE.enabled

export function enterpriseTelemetryEnabled(profile: { enabled: boolean }, dsn?: string) {
  return !profile.enabled && Boolean(dsn)
}

export function enterpriseURLAllowed(profile: EnterpriseProfile, input: string | URL) {
  if (!profile.enabled) return true
  const url = parseURL(input)
  if (!url) return false
  if (url.username || url.password) return false
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") return true
  return profile.allowedOrigins.includes(url.origin)
}

export function enterpriseRendererRequestAllowed(profile: EnterpriseProfile, input: string | URL) {
  if (!profile.enabled) return true
  const url = parseURL(input)
  if (!url) return false
  if (url.username || url.password) return false
  if (url.protocol === "opencode:") return url.host === "app"
  if (url.protocol === "oc:") return url.host === "renderer"
  if (url.protocol === "data:" || url.protocol === "blob:") return true
  return enterpriseURLAllowed(profile, url)
}

export function enterpriseURLOrigin(input: string | URL) {
  return parseURL(input)?.origin ?? "<invalid>"
}

export function createEnterpriseURLHandler<T>(profile: EnterpriseProfile, handler: (url: string) => T) {
  return (url: string) => {
    if (!enterpriseURLAllowed(profile, url)) return undefined
    return handler(url)
  }
}

export function createEnterpriseRendererNetwork(
  profile: EnterpriseProfile,
  input: { openLink: (url: string) => void; fetch: typeof fetch },
) {
  const fetcher: typeof fetch = (request, init) => {
    const url = request instanceof Request ? request.url : request
    if (!enterpriseURLAllowed(profile, url)) {
      return Promise.reject(new Error(`Enterprise offline policy blocked ${enterpriseURLOrigin(url)}`))
    }
    if (request instanceof Request) return input.fetch(request)
    return input.fetch(request, init)
  }
  return {
    openLink: createEnterpriseURLHandler(profile, input.openLink),
    fetch: fetcher,
  }
}

export function desktopNotificationOptions(profile: EnterpriseProfile, body: string, rendererURL: string) {
  if (profile.enabled) return { body }
  return {
    body,
    icon: new URL("./favicon-96x96-v3.png", rendererURL).toString(),
  }
}

function parseURL(input: string | URL) {
  try {
    return new URL(input)
  } catch {
    return undefined
  }
}
