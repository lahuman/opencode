import { defineConfig } from "electron-vite"
import type { Plugin } from "vite"
import { parseEnterpriseProfile } from "./src/enterprise-profile"
import { BetaNotes } from "./script/beta-notes"
import { pickerPlugin } from "./script/picker"
import { nodePtyPackage } from "./script/utils"

function resolveChannel() {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "local" || raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

const appPlugin = (await import("@opencode/app/vite")).default

const enterpriseProfile = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: process.env.OPENCODE_ENTERPRISE,
  OPENCODE_ENTERPRISE_MODELS: process.env.OPENCODE_ENTERPRISE_MODELS,
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: process.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID,
  OPENCODE_ENTERPRISE_BASE_URL: process.env.OPENCODE_ENTERPRISE_BASE_URL,
  OPENCODE_ENTERPRISE_MODEL_ID: process.env.OPENCODE_ENTERPRISE_MODEL_ID,
  OPENCODE_ENTERPRISE_MODEL_NAME: process.env.OPENCODE_ENTERPRISE_MODEL_NAME,
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: process.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION,
  OPENCODE_ENTERPRISE_GUIDE_VERSION: process.env.OPENCODE_ENTERPRISE_GUIDE_VERSION,
  OPENCODE_ENTERPRISE_CATALOG_VERSION: process.env.OPENCODE_ENTERPRISE_CATALOG_VERSION,
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS,
})

const enterprise = enterpriseProfile.enabled
  ? {
      "import.meta.env.OPENCODE_ENTERPRISE": JSON.stringify("1"),
      "import.meta.env.OPENCODE_ENTERPRISE_MODELS": JSON.stringify(JSON.stringify(enterpriseProfile.models)),
      "import.meta.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID": JSON.stringify(enterpriseProfile.defaultModelID),
      "import.meta.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION": JSON.stringify(enterpriseProfile.defaultsVersion),
      "import.meta.env.OPENCODE_ENTERPRISE_GUIDE_VERSION": JSON.stringify(enterpriseProfile.guideVersion),
      "import.meta.env.OPENCODE_ENTERPRISE_CATALOG_VERSION": JSON.stringify(enterpriseProfile.catalogVersion),
      "import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS": JSON.stringify(enterpriseProfile.allowedOrigins.join(",")),
    }
  : {
      "import.meta.env.OPENCODE_ENTERPRISE": JSON.stringify("0"),
      "import.meta.env.OPENCODE_ENTERPRISE_MODELS": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_DEFAULTS_VERSION": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_GUIDE_VERSION": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_CATALOG_VERSION": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS": JSON.stringify(""),
    }

const sentry =
  !enterpriseProfile.enabled && process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? (await import("@sentry/vite-plugin")).sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

// Every module the entry reaches through static imports lands in one chunk. Automatic splitting
// otherwise fragments the initial graph into ~50 files shared with lazy routes, and each file costs
// the renderer a main-thread request round trip through the main process before first paint.
// Rolldown hands every chunk-name call a fresh context, so the graph is walked once per output.
const initialGraph = new Set<string>()

const initialChunk: Plugin = {
  name: "opencode-desktop:initial-chunk",
  renderStart() {
    const entries = [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isEntry)
    initialGraph.clear()
    entries.forEach((id) => initialGraph.add(id))

    // A Set's iterator also visits members added while iterating, so this reaches every static import.
    for (const id of initialGraph) this.getModuleInfo(id)?.importedIds.forEach((imported) => initialGraph.add(imported))
  },
}

export default defineConfig(async ({ command }) => {
  const channel = resolveChannel()
  const nodePtyPkg = nodePtyPackage()

  // Beta builds carry their commit and recent history for the updater's "What's new in beta"; the dev server carries
  // them without asking GitHub, so the page can be tried; other channels none.
  const betaNotes = enterprise
    ? undefined
    : channel === "beta"
      ? await BetaNotes.enrich(BetaNotes.embed(), { token: process.env.GITHUB_TOKEN })
      : command === "serve"
        ? BetaNotes.embed()
        : undefined

  return {
    main: {
      resolve: {
        dedupe: ["effect"],
      },
      define: {
        ...enterprise,
        // Local renderer/server mode still uses the dev application identity and updater policy.
        "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel === "local" ? "dev" : channel),
      },
      build: {
        minify: command === "build",
        rolldownOptions: {
          input: { index: "src/main/index.ts" },
          output: {
            format: "es",
            // DesktopPaths resolves resources from the main output directory,
            // including when the lazy desktop entry shares it with other chunks.
            chunkFileNames: "[name]-[hash].js",
          },
        },
        externalizeDeps: {
          // Bundle the Effect family together.
          exclude: ["effect", "@effect/platform-node", "@effect/platform-node-shared", "drizzle-orm"],
          include: [nodePtyPkg],
        },
      },
      plugins: [
        {
          name: "opencode:node-pty-narrower",
          enforce: "pre",
          resolveId(s) {
            if (s === "@lydell/node-pty") return nodePtyPkg

            return undefined
          },
        },
        {
          // Rolldown emits its own scoped createRequire runtime for CommonJS dependencies.
          // electron-vite's post-bundle regex shim injects a top-level `const require` that collides
          // with bundled ESM modules declaring their own `require` (such as @effect/platform-node).
          name: "opencode:disable-esm-shim",
          configResolved(config) {
            const shim = config.plugins.find((plugin) => plugin.name === "vite:esm-shim")

            if (shim) delete shim.renderChunk
          },
        },
      ],
    },
    preload: {
      define: enterprise,
      build: {
        minify: command === "build",
        rolldownOptions: {
          input: { index: "src/preload/index.ts" },
          output: {
            format: "cjs",
            // The package is "type": "module". Under --no-sandbox Electron loads the preload
            // through Node's module loader, which treats a .js file as ESM and fails on
            // require("electron"). The sandboxed path ignores the extension.
            entryFileNames: "[name].cjs",
          },
        },
      },
    },
    renderer: {
      experimental: {
        bundledDev: true,
      },
      define: {
        ...enterprise,
        "import.meta.env.OPENCODE_VERSION": JSON.stringify(process.env.OPENCODE_VERSION),
        "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        "import.meta.env.OPENCODE_COMMIT": betaNotes ? JSON.stringify(betaNotes.sha) : "undefined",
        "import.meta.env.OPENCODE_BETA_NOTES": betaNotes ? JSON.stringify(JSON.stringify(betaNotes)) : "undefined",
        "import.meta.env.OPENCODE_TEST_ONBOARDING": JSON.stringify(
          command === "serve" && process.env.OPENCODE_TEST_ONBOARDING === "1",
        ),
      },
      plugins: [pickerPlugin(), appPlugin, initialChunk],
      publicDir: "../../../app/public",
      root: "src/renderer",
      build: {
        minify: command === "build",
        sourcemap: !enterpriseProfile.enabled,
        rolldownOptions: {
          input: {
            main: "src/renderer/index.html",
          },
          output: {
            codeSplitting: {
              groups: [{ name: (id) => (initialGraph.has(id) ? "app" : null), priority: 10 }],
            },
          },
        },
      },
    },
  }
})
