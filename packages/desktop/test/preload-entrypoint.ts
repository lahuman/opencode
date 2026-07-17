import { mock } from "bun:test"
import type { ElectronAPI } from "../src/preload/types"

const invocations: { channel: string; args: unknown[] }[] = []
let exposed: { key: string; api: ElectronAPI } | undefined

mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: ElectronAPI) => {
      exposed = { key, api }
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invocations.push({ channel, args })
      if (channel === "enterprise-guide-read") {
        return Promise.resolve({ version: "2026.08", markdown: "# Concrete guide" })
      }
      return Promise.resolve(undefined)
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  },
  webUtils: {
    getPathForFile: () => "",
  },
}))

await import("../src/preload/index")

if (!exposed) throw new Error("Preload entrypoint did not expose an API")
const guide = await exposed.api.enterprise.readGuide()
await exposed.api.relaunch()

console.log(JSON.stringify({ key: exposed.key, guide, invocations }))
