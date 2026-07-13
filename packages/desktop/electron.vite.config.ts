import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { parseEnterpriseProfile } from "./src/enterprise-profile"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const enterpriseProfile = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: process.env.OPENCODE_ENTERPRISE,
  OPENCODE_ENTERPRISE_BASE_URL: process.env.OPENCODE_ENTERPRISE_BASE_URL,
  OPENCODE_ENTERPRISE_MODEL_ID: process.env.OPENCODE_ENTERPRISE_MODEL_ID,
  OPENCODE_ENTERPRISE_MODEL_NAME: process.env.OPENCODE_ENTERPRISE_MODEL_NAME,
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS: process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS,
})

const enterprise = enterpriseProfile.enabled
  ? {
      "import.meta.env.OPENCODE_ENTERPRISE": JSON.stringify("1"),
      "import.meta.env.OPENCODE_ENTERPRISE_BASE_URL": JSON.stringify(enterpriseProfile.baseURL),
      "import.meta.env.OPENCODE_ENTERPRISE_MODEL_ID": JSON.stringify(enterpriseProfile.modelID),
      "import.meta.env.OPENCODE_ENTERPRISE_MODEL_NAME": JSON.stringify(enterpriseProfile.modelName),
      "import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS": JSON.stringify(enterpriseProfile.allowedOrigins.join(",")),
    }
  : {
      "import.meta.env.OPENCODE_ENTERPRISE": JSON.stringify("0"),
      "import.meta.env.OPENCODE_ENTERPRISE_BASE_URL": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_MODEL_ID": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_MODEL_NAME": JSON.stringify(""),
      "import.meta.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS": JSON.stringify(""),
    }

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
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

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      ...enterprise,
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    define: enterprise,
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
