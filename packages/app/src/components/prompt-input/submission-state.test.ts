import { expect, test } from "bun:test"
import { createPromptState, DEFAULT_PROMPT } from "@/context/prompt"
import { createPromptSubmissionState } from "./submission-state"

test("keeps the destination composer clear when retargeting a cleared submission", () => {
  const initial = createPromptState({ prompt: "first prompt" })
  const destination = createPromptState({ prompt: "stale destination draft" })
  const submission = createPromptSubmissionState({
    target: initial.capture(),
    prompt: initial.current(),
    context: [],
  })

  submission.clear()
  submission.retarget(destination.capture())

  expect(initial.current()).toEqual(DEFAULT_PROMPT)
  expect(destination.current()).toEqual(DEFAULT_PROMPT)
})
