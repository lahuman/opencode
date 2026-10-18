import { expect, test } from "bun:test"
import { createMemoryComposerState } from "../state"
import { createComposerSubmission } from "../submission-state"

test("keeps the destination composer clear when retargeting a cleared submission", () => {
  const initial = createMemoryComposerState().capture()
  const destination = createMemoryComposerState().capture()
  initial.set([{ type: "text", content: "first prompt", start: 0, end: 12 }])
  destination.set([{ type: "text", content: "stale destination draft", start: 0, end: 23 }])
  const submission = createComposerSubmission({
    target: initial,
    prompt: initial.current(),
    context: [],
  })

  submission.clear()
  submission.retarget(destination)

  expect(initial.current()).toMatchObject([{ type: "text", content: "" }])
  expect(destination.current()).toMatchObject([{ type: "text", content: "" }])
})
