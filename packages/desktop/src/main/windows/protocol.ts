import { net, protocol, session } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { documentPolicyHeader, jsCallStacksDocumentPolicy } from "./headers"
import { extensionHost, rendererHost, rendererProtocol } from "./scheme"
import { ENTERPRISE_ENABLED, ENTERPRISE_PROFILE, enterpriseContentSecurityPolicy } from "../../enterprise"

export type ProtocolReport = (level: "warning" | "error", message: string, data: Record<string, unknown>) => void

export type ExtensionAssets = (request: Request, url: URL) => Response | Promise<Response>

// The entry module registers the handler the moment the first window exists, before logging is up,
// so problems go to the console until the logging layer installs a reporter.
let report: ProtocolReport = (level, message, data) => console[level === "error" ? "error" : "warn"](message, data)

// Extension files live in the storage database, which opens after the first window starts loading.
let extensionAssets: ExtensionAssets = () => new Response(null, { status: 503 })

export function setProtocolReporter(reporter: ProtocolReport) {
  report = reporter
}

export function setExtensionAssets(provider: ExtensionAssets) {
  extensionAssets = provider
}

// Requests in flight and when the last one arrived. The entry module holds the main bundle back
// until the renderer's initial burst of asset requests has been answered, because this handler
// runs on the main thread and a 100 ms module evaluation would otherwise sit between the renderer
// and its HTML.
let inflight = 0

let served = 0

let lastRequest = 0

export function rendererAssetsServed(options: { quietMs: number; capMs: number }) {
  const start = Date.now()

  return new Promise<void>((resolve) => {
    const check = () => {
      const now = Date.now()

      if (now - start >= options.capMs) return resolve()

      if (served > 0 && inflight === 0 && now - lastRequest >= options.quietMs) return resolve()
      setTimeout(check, 5)
    }

    check()
  })
}

export function registerRendererProtocol(rendererRoot: string) {
  if (protocol.isProtocolHandled(rendererProtocol)) return
  const assets = ENTERPRISE_ENABLED ? session.fromPartition("opencode-renderer-assets") : net

  protocol.handle(rendererProtocol, async (request) => {
    inflight++
    lastRequest = Date.now()

    try {
      return await serve(request, rendererRoot, assets)
    } finally {
      inflight--
      served++
    }
  })
}

async function serve(request: Request, rendererRoot: string, assets: Pick<typeof net, "fetch">) {
  if (!URL.canParse(request.url)) return rejectRendererRequest("invalid-url")
  const url = new URL(request.url)

  if (url.host === extensionHost) {
    return Promise.resolve()
      .then(() => extensionAssets(request, url))
      .catch((error: unknown) => {
        report("error", "extension asset error", { url: request.url, error })

        return new Response(null, { status: 500 })
      })
  }

  if (url.host !== rendererHost) {
    return rejectRendererRequest("invalid-host")
  }

  const pathname = decodeRendererPath(url.pathname)
  if (pathname === undefined) return rejectRendererRequest("invalid-encoding")
  const file = path.resolve(rendererRoot, `.${pathname}`)
  const rel = path.relative(rendererRoot, file)

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return rejectRendererRequest("path-traversal")
  }

  try {
    const range = request.headers.get("range")
    const response = await assets.fetch(pathToFileURL(file).toString(), { headers: range ? { range } : undefined })

    if (response.status >= 400) {
      report("error", "fetch failed", {
        reason: "asset-fetch-failed",
        status: response.status,
      })
    }

    return addDocumentPolicy(response, file)
  } catch {
    report("error", "fetch error", { reason: "asset-fetch-error", status: 404 })

    return new Response("Not found", { status: 404 })
  }
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  const csp = enterpriseContentSecurityPolicy(ENTERPRISE_PROFILE)
  if (csp) headers.set("Content-Security-Policy", csp)

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function decodeRendererPath(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function rejectRendererRequest(reason: string) {
  report("warning", "rejected renderer asset request", { reason, status: 404 })
  return new Response("Not found", { status: 404 })
}
