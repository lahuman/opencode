import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { prepareEnterpriseRipgrep } from "./prepare-enterprise-ripgrep"

const roots: string[] = []
const archiveRoot = "ripgrep-15.1.0-x86_64-pc-windows-msvc"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("does not download ripgrep for a general desktop build", async () => {
  const output = await temporaryOutput()
  let requests = 0
  await prepareEnterpriseRipgrep({
    env: {},
    output,
    fetch: async () => {
      requests++
      return new Response()
    },
  })
  expect(requests).toBe(0)
  expect(await Bun.file(path.join(output, "rg.exe")).exists()).toBe(false)
})

test("downloads a verified archive and extracts only the executable and license files", async () => {
  const output = await temporaryOutput()
  const archive = await zip({
    [`${archiveRoot}/rg.exe`]: "executable",
    [`${archiveRoot}/LICENSE-MIT`]: "MIT license",
    [`${archiveRoot}/UNLICENSE`]: "Unlicense",
    [`${archiveRoot}/README.md`]: "not extracted",
  })
  await prepareEnterpriseRipgrep({
    env: { OPENCODE_ENTERPRISE: "1" },
    output,
    integrity: digest(archive),
    fetch: async () => new Response(archive, { status: 200 }),
  })

  expect(await Bun.file(path.join(output, "rg.exe")).text()).toBe("executable")
  expect(await Bun.file(path.join(output, "LICENSE-MIT")).text()).toBe("MIT license")
  expect(await Bun.file(path.join(output, "UNLICENSE")).text()).toBe("Unlicense")
  expect(await Bun.file(path.join(output, "README.md")).exists()).toBe(false)
})

test("rejects an archive with the wrong checksum", async () => {
  const output = await temporaryOutput()
  const archive = await zip({ [`${archiveRoot}/rg.exe`]: "executable" })
  await expect(
    prepareEnterpriseRipgrep({
      env: { OPENCODE_ENTERPRISE: "1" },
      output,
      integrity: "0".repeat(64),
      fetch: async () => new Response(archive, { status: 200 }),
    }),
  ).rejects.toThrow("Enterprise ripgrep archive checksum mismatch")
})

test("rejects a zip with an unexpected root or missing license", async () => {
  const output = await temporaryOutput()
  const archive = await zip({
    ["unexpected/rg.exe"]: "executable",
    [`${archiveRoot}/LICENSE-MIT`]: "MIT license",
    [`${archiveRoot}/UNLICENSE`]: "Unlicense",
  })
  await expect(
    prepareEnterpriseRipgrep({
      env: { OPENCODE_ENTERPRISE: "1" },
      output,
      integrity: digest(archive),
      fetch: async () => new Response(archive, { status: 200 }),
    }),
  ).rejects.toThrow("Enterprise ripgrep archive has an unexpected structure")
})

test("rejects an archive entry that escapes the expected release root", async () => {
  const output = await temporaryOutput()
  const archive = await zip({
    [`${archiveRoot}/rg.exe`]: "executable",
    [`${archiveRoot}/LICENSE-MIT`]: "MIT license",
    [`${archiveRoot}/UNLICENSE`]: "Unlicense",
    ["outside.txt"]: "outside",
  })
  await expect(
    prepareEnterpriseRipgrep({
      env: { OPENCODE_ENTERPRISE: "1" },
      output,
      integrity: digest(archive),
      fetch: async () => new Response(archive, { status: 200 }),
    }),
  ).rejects.toThrow("Enterprise ripgrep archive has an unexpected structure")
})

test("reports a failed download without exposing request details", async () => {
  await expect(
    prepareEnterpriseRipgrep({
      env: { OPENCODE_ENTERPRISE: "1" },
      output: await temporaryOutput(),
      fetch: async () => new Response("proxy-secret", { status: 503 }),
    }),
  ).rejects.toThrow("Failed to download enterprise ripgrep: HTTP 503")
})

test("sanitizes a failed download cause before preserving it", async () => {
  const error = await prepareEnterpriseRipgrep({
    env: { OPENCODE_ENTERPRISE: "1" },
    output: await temporaryOutput(),
    fetch: async () =>
      Promise.reject({
        _tag: "RequestError",
        request: { headers: { "proxy-authorization": "secret-marker" } },
      }),
  }).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected download error")
  expect(error.message).toBe("Failed to download enterprise ripgrep: RequestError")
  expect(error.cause).toBeInstanceOf(Error)
  expect((error.cause as Error).message).toBe("RequestError")
  expect(`${error.message} ${String(error.cause)}`).not.toContain("secret-marker")
})

test("sanitizes response body failures while retaining actionable diagnostics", async () => {
  const error = await prepareEnterpriseRipgrep({
    env: { OPENCODE_ENTERPRISE: "1" },
    output: await temporaryOutput(),
    fetch: async () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          Promise.reject(
            new Error(
              "socket reset; proxy-authorization: Basic secret-marker; proxy https://user:password@proxy.example",
            ),
          ),
      }) as Response,
  }).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected download error")
  expect(error.message).toContain("socket reset")
  expect(error.cause).toBeInstanceOf(Error)
  expect(`${error.message} ${String(error.cause)}`).not.toContain("secret-marker")
  expect(`${error.message} ${String(error.cause)}`).not.toContain("user:password")
})

async function temporaryOutput() {
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-ripgrep-"))
  roots.push(root)
  return path.join(root, "ripgrep")
}

async function zip(files: Record<string, string>) {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { extendedTimestamp: false })
  await Object.entries(files).reduce(async (previous, [name, value]) => {
    await previous
    await writer.add(name, new TextReader(value), { extendedTimestamp: false })
  }, Promise.resolve())
  return new Uint8Array(await (await writer.close()).arrayBuffer())
}

function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
