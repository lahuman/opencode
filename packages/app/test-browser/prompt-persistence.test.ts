import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createPromptReady, createPromptSession } from "@/context/prompt-state"
import { ServerScope } from "@/utils/server-scope"
import { createDraftStore } from "@/utils/draft-store"

let read: ((value: string | null) => void) | undefined

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  draftStore: {
    ...storage,
    putBlob: async () => {
      throw new Error("putBlob is not used by this test")
    },
  },
}

describe("prompt persistence", () => {
  test("waits for an async draft to hydrate before reporting ready", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = createPromptSession(ServerScope.local, { draftID: "draft-async" }, undefined, platform)
        const ready = createPromptReady(() => session)

        expect(ready()).toBe(false)
        expect(session.current()[0]).toMatchObject({ type: "text", content: "" })

        read?.(
          JSON.stringify({
            prompt: [{ type: "text", content: "persisted draft", start: 0, end: 15 }],
            cursor: 15,
            context: { items: [] },
          }),
        )

        createEffect(() => {
          if (!ready()) return
          try {
            expect(session.current()[0]).toMatchObject({ type: "text", content: "persisted draft" })
            dispose()
            resolve()
          } catch (error) {
            dispose()
            reject(error)
          }
        })
      })
    })
  })
})

test("moves legacy image data URLs into blobs and hydrates object URLs", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => void documents.delete(key),
    putBlob: async (blob) => {
      const id = String(blob.size)
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }))
  expect(documents.get("prompt")).not.toContain("dataUrl")
  const value = JSON.parse((await store.getItem("prompt"))!)
  expect(value.prompt[0].blob.id).toBe("1")
  expect(value.prompt[0].blob.url).toStartWith("blob:")
})

test("does not let delayed blob migration overwrite a newer draft", async () => {
  const documents = new Map<string, string>()
  const migration = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => void documents.set(key, value),
    remove: async () => undefined,
    putBlob: async () => {
      await migration.promise
      return "blob"
    },
    getBlob: async () => null,
  })
  const older = store.setItem(
    "prompt",
    JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }),
  )
  await Bun.sleep(0)
  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "latest" }] }))
  migration.resolve()
  await older

  expect(documents.get("prompt")).toContain("latest")
})

test("passes malformed draft documents through for persistence recovery", async () => {
  const store = createDraftStore({
    get: async () => "{malformed",
    set: async () => undefined,
    remove: async () => undefined,
    putBlob: async () => "unused",
    getBlob: async () => null,
  })

  expect(await store.getItem("prompt")).toBe("{malformed")
})

test("keeps browser draft storage available and skips blob cleanup for malformed documents", async () => {
  const deleted: string[] = []
  const documents = eventSource({ result: ["{malformed"] })
  const cursor = eventSource({
    result: {
      key: "possibly-referenced",
      delete: () => deleted.push("possibly-referenced"),
      continue() {
        cursor.result = undefined
        cursor.dispatch("success")
      },
    } as { key: string; delete: () => void; continue: () => void } | undefined,
  })
  const cleanup = eventSource({
    objectStore(name: string) {
      if (name === "documents") return { getAll: () => documents }
      return { openKeyCursor: () => cursor }
    },
  })
  const database = {
    transaction(store: string | string[]) {
      if (Array.isArray(store)) return cleanup
      const request = eventSource({ result: undefined })
      queueMicrotask(() => request.dispatch("success"))
      return { objectStore: () => ({ get: () => request }) }
    },
  }
  const open = eventSource({ result: database })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open: () => open } as unknown as IDBFactory,
  })

  try {
    const { createBrowserDraftStore } = await import("@/utils/draft-store")
    const store = createBrowserDraftStore()
    open.dispatch("success")
    documents.dispatch("success")
    cursor.dispatch("success")
    cleanup.dispatch("complete")

    expect(await store.getItem("missing")).toBeNull()
    expect(deleted).toEqual([])
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor)
    if (!descriptor) Reflect.deleteProperty(globalThis, "indexedDB")
  }
})

function eventSource<T extends object>(value: T) {
  const listeners = new Map<string, (() => void)[]>()
  return Object.assign(value, {
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type)
      if (current) current.push(listener)
      if (!current) listeners.set(type, [listener])
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  })
}
