import { app, protocol } from "electron"
import type { BrowserWindow } from "electron"
import { ENTERPRISE_ENABLED } from "../../enterprise"

export const rendererProtocol = "oc"

export const rendererHost = "renderer"

/** Files of installed GUI extensions: `oc://extensions/<id>/<path>`. */
export const extensionHost = "extensions"

export function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = ENTERPRISE_ENABLED && app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

  if (devUrl) {
    if (ENTERPRISE_ENABLED) {
      const url = new URL(devUrl)
      if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Enterprise development renderer must use loopback")
    }
    void win.loadURL(new URL(html, devUrl).toString())

    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

export function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)

  if (html && !url.pathname.endsWith(".html")) return false

  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = ENTERPRISE_ENABLED && app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

  if (!devUrl || !URL.canParse(devUrl)) return false

  return url.origin === new URL(devUrl).origin
}

export function isTrustedRendererDocument(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password || url.search) return false
  const dev = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  const expected = new URL(dev ? new URL("index.html", dev) : `${rendererProtocol}://${rendererHost}/index.html`)
  return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
}

// Scheme privileges can only be granted before the app is ready, so the entry module calls this
// before it loads anything else.
export function registerRendererScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: rendererProtocol,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        // Extension fonts and fetched assets are cross-origin to the renderer.
        corsEnabled: true,
        stream: true,
        // Let Chromium keep V8 bytecode for the renderer bundle between launches.
        codeCache: true,
      },
    },
  ])
}
