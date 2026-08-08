// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  PlatformProvider,
  ServerConnection,
  useCommand,
  useWslServers,
  useLanguage,
} from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { t } from "./i18n"
import { initializationData } from "./initialization"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { windowFullscreen } from "./window-fullscreen"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import "./styles.css"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ENTERPRISE_ENABLED, ENTERPRISE_PROFILE, enterpriseTelemetryEnabled } from "../enterprise"
import { createPlatform, type DesktopWindowState } from "./platform"

if (ENTERPRISE_ENABLED) document.title = "Kernexa"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("desktop.error.dev.rootNotFound"))
}

if (enterpriseTelemetryEnabled(ENTERPRISE_PROFILE, import.meta.env.VITE_SENTRY_DSN)) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

function windowLastActiveUrlKey(windowID: string) {
  return `opencode.desktop.window.${windowID}.last-active-url`
}

function getLastActiveUrl(windowID: string) {
  if (typeof localStorage !== "object") return "/"
  try {
    const value = localStorage.getItem(windowLastActiveUrlKey(windowID))
    if (value?.startsWith("/") && !value.startsWith("//")) return value
  } catch {}
  return "/"
}

function setLastActiveUrl(windowID: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(windowLastActiveUrlKey(windowID), value)
  } catch {}
}

function DesktopMemoryRouter(props: BaseRouterProps & { windowID: string }) {
  const history = createMemoryHistory()
  const initialUrl = getLastActiveUrl(props.windowID)
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  onCleanup(history.listen((value) => setLastActiveUrl(props.windowID, value)))
  return <MemoryRouter {...props} history={history} />
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

function LoadingSplash() {
  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <Splash class="w-16 h-20 opacity-50 animate-pulse" />
    </div>
  )
}

function DesktopRoot(props: { windowState: DesktopWindowState }) {
  const platform = createPlatform(props.windowState, updaterState, {
    acceptedFileExtensions: ACCEPTED_FILE_EXTENSIONS,
    makeServerKey: ServerConnection.Key.make,
    windowFullscreen,
  })
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)
  const router = (props: BaseRouterProps) => (
    <DesktopMemoryRouter {...props} windowID={platform.windowID ?? "browser"} />
  )
  const onboarding = Promise.withResolvers<void>()

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const language = useLanguage()
    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !locale.loading && !wslServers.isLoading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      if (ENTERPRISE_ENABLED) return list.filter(ServerConnection.builtin)
      list.push(...readyWslConnections(wslServers.data, language.t("wsl.server.label")))
      return list
    })
    const effectiveDefaultServer = createMemo(() => {
      if (ENTERPRISE_ENABLED) return ServerConnection.Key.make("sidecar")
      return ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data))
    })
    return (
      <Show when={ready()} fallback={<LoadingSplash />}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={router}
              startup={onboarding.promise}
              serverScoped={
                <DesktopFirstLaunchOnboarding
                  initialUrl={getLastActiveUrl(platform.windowID ?? "browser")}
                  onLoaded={onboarding.resolve}
                />
              }
            >
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => void window.api.setNativeTranslations(bundle).catch(() => undefined)}
      >
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

render(() => {
  const [windowState] = createResource(async () => {
    const api = window.api as typeof window.api & {
      getWindowID?: () => Promise<string>
    }
    return { id: await api.getWindowID?.() }
  })

  return (
    <Show when={windowState.latest} fallback={<LoadingSplash />} keyed>
      {(state) => <DesktopRoot windowState={state} />}
    </Show>
  )
}, root!)
