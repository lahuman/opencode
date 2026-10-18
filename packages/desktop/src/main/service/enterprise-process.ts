import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Option, Schema } from "effect"
import type { EnterpriseProviderCatalog } from "../enterprise-providers"
import type { EnterpriseProviderCredentials } from "../enterprise-credentials"

const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))

export async function launchEnterpriseProcess(input: {
  command: readonly string[]
  env: Record<string, string>
  bootstrap: { password: string; catalog: EnterpriseProviderCatalog; credentials: EnterpriseProviderCredentials }
}) {
  const child = spawn(input.command[0], [...input.command.slice(1), "serve", "--stdio", "--port", "0"], {
    env: { ...input.env, OPENCODE_ENTERPRISE_DESKTOP_IPC: "1" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  // Diagnostics are intentionally not forwarded: a failing provider or plugin can print a secret.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout, terminal: false })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const password = input.bootstrap.password
  let stopped = false
  const stop = async () => {
    if (stopped) return exited
    stopped = true
    child.stdin.end()
    const timeout = setTimeout(() => child.kill(), 6_000)
    try {
      await exited
    } finally {
      clearTimeout(timeout)
      lines.close()
    }
  }
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Enterprise server startup timed out")), 60_000)
      const done = (url: string) => {
        clearTimeout(timeout)
        resolve(url)
      }
      const fail = () => {
        clearTimeout(timeout)
        reject(new Error("Enterprise server exited before becoming ready"))
      }
      child.once("error", fail)
      child.once("exit", fail)
      lines.on("line", (line) => {
        if (!line.startsWith('{"url":')) return
        const decoded = decodeReady(line)
        if (Option.isNone(decoded) || !URL.canParse(decoded.value.url)) return
        const url = new URL(decoded.value.url)
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return
        child.off("error", fail)
        child.off("exit", fail)
        done(url.origin)
      })
      child.stdin.on("error", fail)
      child.stdin.write(`${JSON.stringify(input.bootstrap)}\n`)
    })
    return { url, password, stop }
  } catch (error) {
    child.kill()
    lines.close()
    throw error
  } finally {
    // Release the plaintext store snapshot as soon as the startup handshake finishes.
    input.bootstrap.credentials = { schemaVersion: 3, providers: {} }
  }
}
