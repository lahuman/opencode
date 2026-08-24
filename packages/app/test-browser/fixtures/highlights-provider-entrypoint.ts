import "../../happydom"
import "../solid-jsx"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { Platform } from "../../src/context/platform"
import { PlatformProvider } from "../../src/context/platform"
import { SettingsProvider } from "../../src/context/settings"
import { HighlightsProvider } from "../../src/context/highlights"

async function mountHighlights(enterprise: boolean) {
  const calls: string[] = []
  const values = new Map<string, string>([["highlights.v1", JSON.stringify({ version: "1.0.0" })]])
  const storage: AsyncStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
      if (key === "highlights.v1") calls.push(`seen ${JSON.parse(value).version}`)
    },
    removeItem: async (key) => {
      values.delete(key)
    },
  }
  const platform: Platform = {
    platform: "desktop",
    version: "2.0.0",
    ...(enterprise
      ? {
          enterprise: {
            providerCatalog: async () => ({ schemaVersion: 1 as const, providers: [] }),
            createProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
            updateProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
            deleteProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
            createModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
            updateModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
            deleteModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
            setDefaultModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
            replaceProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
            clearProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
            readGuide: async () => ({ version: "chai-1", markdown: "" }),
          },
        }
      : {}),
    get fetch() {
      calls.push("select fetcher")
      return ((_input: RequestInfo | URL) => {
        calls.push("network")
        return Promise.resolve(
          new Response(JSON.stringify({ releases: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }) as typeof fetch
    },
    openDirectoryPickerDialog: async () => null,
    openLink() {},
    restart: async () => undefined,
    back() {},
    forward() {},
    notify: async () => undefined,
    storage: () => storage,
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return () =>
            createComponent(DialogProvider, {
              get children() {
                return () =>
                  createComponent(SettingsProvider, {
                    get children() {
                      return () => createComponent(HighlightsProvider, { children: null })
                    },
                  })
              },
            })
        },
      }),
    host,
  )

  try {
    const deadline = Date.now() + 2_000
    while (JSON.parse(values.get("highlights.v1") ?? "{}").version !== "2.0.0") {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for highlights: ${calls.join(", ")}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return { calls, stored: JSON.parse(values.get("highlights.v1") ?? "{}") }
  } finally {
    dispose()
    host.remove()
  }
}

console.log(
  JSON.stringify({
    enterprise: await mountHighlights(true),
    public: await mountHighlights(false),
  }),
)
