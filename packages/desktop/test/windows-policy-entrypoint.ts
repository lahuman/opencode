import { mock } from "bun:test"

mock.module("electron", () => ({
  default: { app: { getPath: () => "" } },
  app: {
    dock: undefined,
    exit() {},
    getPath: () => "",
    isPackaged: false,
    quit() {},
    relaunch() {},
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    static getFocusedWindow() {}
  },
  crashReporter: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
  netLog: {},
  protocol: {
    handle() {},
    isProtocolHandled: () => false,
    registerSchemesAsPrivileged() {},
  },
  shell: { openExternal() {}, openPath() {} },
}))

type RequestResult = { cancel: boolean }
type RequestDetails = { url: string; resourceType: string; requestHeaders?: Record<string, string> }
type RequestHandler = (details: RequestDetails, callback: (result: RequestResult) => void) => void
type WindowOpenHandler = (details: { url: string }) => { action: "allow" | "deny" }
type NavigationEvent = { preventDefault(): void }
type NavigationHandler = (event: NavigationEvent, url: string) => void

function createBoundary() {
  const callbacks: {
    request?: RequestHandler
    windowOpen?: WindowOpenHandler
    navigation?: NavigationHandler
  } = {}
  return {
    callbacks,
    win: {
      webContents: {
        session: {
          webRequest: {
            onBeforeRequest: (callback: RequestHandler) => {
              callbacks.request = callback
            },
          },
        },
        setWindowOpenHandler: (callback: WindowOpenHandler) => {
          callbacks.windowOpen = callback
        },
        on: (event: string, callback: NavigationHandler) => {
          if (event === "will-navigate") callbacks.navigation = callback
        },
      },
    },
  }
}

function request(callback: RequestHandler | undefined, details: RequestDetails) {
  if (!callback) throw new Error("request boundary was not registered")
  const result: { value?: RequestResult } = {}
  callback(details, (value) => {
    result.value = value
  })
  return result.value
}

function navigate(callback: NavigationHandler | undefined, url: string) {
  if (!callback) throw new Error("navigation boundary was not registered")
  const state = { prevented: false }
  callback(
    {
      preventDefault() {
        state.prevented = true
      },
    },
    url,
  )
  return state.prevented
}

const { installEnterpriseWindowPolicy } = await import("../src/main/windows")
const profile = {
  enabled: true,
  baseURL: "https://llm.corp.example/v1",
  modelID: "company-code",
  modelName: "Company Code",
  defaultsVersion: "pilot-1",
  guideVersion: "pilot-1",
  allowedOrigins: ["https://llm.corp.example"],
} as const
const boundary = createBoundary()
const logs: Array<{ origin: string; resourceType: string }> = []

installEnterpriseWindowPolicy(boundary.win, {
  profile,
  trustedRendererURL: (url) => url.startsWith("oc://renderer/"),
  write: (_service, _message, metadata) => logs.push(metadata),
})

const markdownImage = request(boundary.callbacks.request, {
  url: "https://cdn.example/private.png?token=renderer-secret",
  resourceType: "image",
  requestHeaders: { Authorization: "Bearer hidden" },
})
const providerStylesheet = request(boundary.callbacks.request, {
  url: "https://llm.corp.example/app.css",
  resourceType: "stylesheet",
})
const dataFont = request(boundary.callbacks.request, {
  url: "data:font/woff2;base64,AA==",
  resourceType: "font",
})
const publicStylesheet = request(boundary.callbacks.request, {
  url: "https://cdn.example/private.css?token=style-secret",
  resourceType: "stylesheet",
})
const publicFont = request(boundary.callbacks.request, {
  url: "https://fonts.example/private.woff2?token=font-secret",
  resourceType: "font",
})
const rawFetch = request(boundary.callbacks.request, {
  url: "https://opencode.ai/changelog.json?token=fetch-secret",
  resourceType: "xhr",
})
const malformed = request(boundary.callbacks.request, {
  url: "not a URL?token=malformed-secret",
  resourceType: "other",
})
const windowOpen = {
  public: boundary.callbacks.windowOpen?.({ url: "https://opencode.ai/docs?token=window-secret" }),
  provider: boundary.callbacks.windowOpen?.({ url: "https://llm.corp.example/docs" }),
}
const navigation = {
  trustedPrevented: navigate(boundary.callbacks.navigation, "oc://renderer/index.html"),
  externalPrevented: navigate(boundary.callbacks.navigation, "https://llm.corp.example/docs?token=navigation-secret"),
}
const ordinary = createBoundary()
installEnterpriseWindowPolicy(ordinary.win, {
  profile: { enabled: false },
  trustedRendererURL: () => true,
  write: () => undefined,
})

console.log(
  JSON.stringify({
    registrations: {
      request: Boolean(boundary.callbacks.request),
      windowOpen: Boolean(boundary.callbacks.windowOpen),
      navigation: Boolean(boundary.callbacks.navigation),
    },
    requests: { markdownImage, providerStylesheet, dataFont, publicStylesheet, publicFont, rawFetch, malformed },
    windowOpen,
    navigation,
    logs,
    ordinaryRegistrations: {
      request: Boolean(ordinary.callbacks.request),
      windowOpen: Boolean(ordinary.callbacks.windowOpen),
      navigation: Boolean(ordinary.callbacks.navigation),
    },
  }),
)
