import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopDraftStore } from "./draft-store"

test("flushes the latest buffered draft and stores blobs", () => {
  const store = createDesktopDraftStore(":memory:")
  store.set("prompt", "first")
  store.set("prompt", "latest")
  expect(store.get("prompt")).toBe("latest")
  store.flush()
  expect(store.get("prompt")).toBe("latest")

  const bytes = new TextEncoder().encode("image")
  const id = store.putBlob(bytes)
  expect(store.getBlob(id)).toEqual(bytes)
  store.close()
})

test("skips blob collection when a persisted draft row is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-draft-store-"))
  try {
    const filename = join(root, "drafts.sqlite")
    const bytes = new TextEncoder().encode("referenced image")
    const seed = createDesktopDraftStore(filename)
    const id = seed.putBlob(bytes)
    const malformed = `{"parts":[{"blob":{"id":"${id}"}}]`
    seed.set("prompt", malformed)
    seed.flush()
    seed.close()

    const store = createDesktopDraftStore(filename)
    expect(store.get("prompt")).toBe(malformed)
    expect(store.getBlob(id)).toEqual(bytes)
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
