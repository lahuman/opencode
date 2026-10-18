import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createComposerAttachments } from "@/composer/attachments/attachments"
import { createMemoryComposerState } from "@/composer/state"

describe("prompt attachment session ownership", () => {
  test("adds an asynchronously read image to the session where the read started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createMemoryComposerState(), B: createMemoryComposerState() }
      let active: "A" | "B" = "A"
      const attachments = attachmentsFor({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
      })
      const pending = attachments.addAttachments([new File([new Uint8Array(1024 * 1024)], "a.png", { type: "image/png" })])

      active = "B"
      await pending

      expect(images(sessions.A)).toHaveLength(1)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })

  test("finishes the captured attachment after the active editor is removed", async () => {
    await createRoot(async (dispose) => {
      const prompt = createMemoryComposerState()
      let editor: HTMLDivElement | undefined = document.createElement("div")
      const attachments = attachmentsFor({
        capture: prompt.capture,
        editor: () => editor,
      })
      const pending = attachments.addAttachments([new File([new Uint8Array(1024 * 1024)], "a.png", { type: "image/png" })])

      editor = undefined
      await pending

      expect(images(prompt)).toHaveLength(1)
      dispose()
    })
  })

  test("keeps every file in a batch on the session where the batch started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createMemoryComposerState(), B: createMemoryComposerState() }
      let active: "A" | "B" = "A"
      const attachments = attachmentsFor({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
      })
      const pending = attachments.addAttachments([
        new File([new Uint8Array(1024 * 1024)], "first.png", { type: "image/png" }),
        new File([new Uint8Array(1024 * 1024)], "second.png", { type: "image/png" }),
      ])

      active = "B"
      await pending

      expect(images(sessions.A)).toHaveLength(2)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })

  test("keeps a delayed native clipboard image on the session where paste started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createMemoryComposerState(), B: createMemoryComposerState() }
      const read = Promise.withResolvers<File | null>()
      let active: "A" | "B" = "A"
      const attachments = attachmentsFor({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
        readClipboardImage: () => read.promise,
      })
      const pending = attachments.handlePaste(new ClipboardEvent("paste", { clipboardData: new DataTransfer() }))

      active = "B"
      read.resolve(new File([new Uint8Array(1024 * 1024)], "clipboard.png", { type: "image/png" }))
      await pending

      expect(images(sessions.A)).toHaveLength(1)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })
})

function images(prompt: ReturnType<typeof createMemoryComposerState>) {
  return prompt.current().filter((part) => part.type === "image")
}

function attachmentsFor(input: Pick<Parameters<typeof createComposerAttachments>[0], "capture" | "editor" | "readClipboardImage">) {
  return createComposerAttachments({
    ...input,
    directory: () => "C:/project",
    destination: () => ({ input: { image: true, pdf: true }, local: true, upload: async () => { throw new Error("Unexpected upload") } }),
    isDialogActive: () => false,
    duplicate: () => { throw new Error("Unexpected duplicate") },
    onError: (error) => { throw error },
    onUploadError: (error) => { throw error },
    focusEditor: () => undefined,
    addPart: () => false,
    setDraggingType: () => undefined,
  })
}
