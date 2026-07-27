import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"

export const ENTERPRISE_RIPGREP_VERSION = "15.1.0"
export const ENTERPRISE_RIPGREP_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${ENTERPRISE_RIPGREP_VERSION}/ripgrep-${ENTERPRISE_RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`
export const ENTERPRISE_RIPGREP_SHA256 = "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"

type Env = Record<string, string | undefined>

export async function prepareEnterpriseRipgrep(input: {
  env: Env
  output: string
  fetch?: typeof globalThis.fetch
  integrity?: string
}) {
  if (input.env.OPENCODE_ENTERPRISE !== "1") return

  const response = await (input.fetch ?? globalThis.fetch)(ENTERPRISE_RIPGREP_URL).catch((cause: unknown) => {
    throw downloadFailure(cause)
  })
  if (!response.ok) throw new Error(`Failed to download enterprise ripgrep: HTTP ${response.status}`)
  const archive = new Uint8Array(
    await response.arrayBuffer().catch((cause: unknown) => {
      throw downloadFailure(cause)
    }),
  )
  if (digest(archive) !== (input.integrity ?? ENTERPRISE_RIPGREP_SHA256)) {
    throw new Error("Enterprise ripgrep archive checksum mismatch")
  }

  const reader = new ZipReader(new Uint8ArrayReader(archive))
  const root = `ripgrep-${ENTERPRISE_RIPGREP_VERSION}-x86_64-pc-windows-msvc`
  const names = ["rg.exe", "LICENSE-MIT", "UNLICENSE"] as const
  const selected = await reader
    .getEntries()
    .then(async (entries) => {
      if (
        entries.some((entry) => !safeArchiveEntry(entry.filename, entry.directory, root)) ||
        new Set(entries.map((entry) => entry.filename.toLowerCase())).size !== entries.length
      ) {
        throw new Error("Enterprise ripgrep archive has an unexpected structure")
      }
      return Promise.all(
        names.map(async (name) => {
          const matches = entries.filter((entry) => entry.filename === `${root}/${name}` && !entry.directory)
          if (matches.length !== 1 || !matches[0].getData) {
            throw new Error("Enterprise ripgrep archive has an unexpected structure")
          }
          const bytes = await matches[0].getData(new Uint8ArrayWriter())
          if (bytes.byteLength === 0) throw new Error("Enterprise ripgrep archive contains an empty required file")
          return [name, bytes] as const
        }),
      )
    })
    .finally(() => reader.close())

  await rm(input.output, { recursive: true, force: true })
  await mkdir(input.output, { recursive: true })
  await Promise.all(selected.map(([name, bytes]) => writeFile(path.join(input.output, name), bytes)))
}

function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function safeArchiveEntry(filename: string, directory: boolean, root: string) {
  if (filename === `${root}/`) return directory
  if (!filename.startsWith(`${root}/`) || filename.includes("\\") || filename.includes("\0")) return false
  const relative = filename.slice(root.length + 1)
  const normalized = directory && relative.endsWith("/") ? relative.slice(0, -1) : relative
  return normalized.length > 0 && normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function safeDownloadCause(cause: unknown) {
  const tag = isRecord(cause) && typeof cause._tag === "string"
    ? cause._tag
    : cause instanceof Error && cause.name
      ? cause.name
      : "FetchError"
  const message = cause instanceof Error && cause.message ? redactDownloadMessage(cause.message) : ""
  return new Error(message && message !== tag ? `${tag}: ${message}` : tag)
}

function downloadFailure(cause: unknown) {
  const safe = safeDownloadCause(cause)
  return new Error(`Failed to download enterprise ripgrep: ${safe.message}`, { cause: safe })
}

function redactDownloadMessage(message: string) {
  return message
    .replace(
      /((?:proxy-authorization|authorization|api[-_]?key|token|password)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/giu,
      "$1<redacted>",
    )
    .replace(/:\/\/[^/@\s:]+:[^/@\s]+@/gu, "://<redacted>@")
    .slice(0, 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  await prepareEnterpriseRipgrep({
    env: process.env,
    output: path.resolve(import.meta.dir, "../resources/enterprise/ripgrep"),
  })
}
