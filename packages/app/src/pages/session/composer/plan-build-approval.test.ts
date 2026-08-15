import { describe, expect, test } from "bun:test"
import type { Part, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"
import { isPlanBuildApproval } from "./plan-build-approval"

const canonicalQuestion = {
  header: "Build Agent",
  question: "The plan is ready. Would you like to switch to Build?",
  custom: false,
  options: [
    { label: "Build now", description: "Switch to Build and send an implementation request" },
    { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
  ],
} satisfies QuestionInfo

function request(question: QuestionInfo = canonicalQuestion) {
  return {
    id: "question-plan-exit",
    sessionID: "session-plan",
    questions: [question],
    tool: { messageID: "message-plan", callID: "call-plan-exit" },
  } satisfies QuestionRequest
}

function part(tool: string) {
  return {
    id: "part-plan-exit",
    sessionID: "session-plan",
    messageID: "message-plan",
    type: "tool",
    callID: "call-plan-exit",
    tool,
    state: { status: "running", input: { plan: "# Plan" }, time: { start: 1 } },
  } satisfies Part
}

describe("isPlanBuildApproval", () => {
  test("accepts Build now for a linked plan_exit part", () => {
    expect(
      isPlanBuildApproval({
        request: request({ ...canonicalQuestion, header: "Changed display copy" }),
        answers: [["Build now"]],
        parts: [part("plan_exit")],
      }),
    ).toBe(true)
  })

  test("accepts the canonical Plan-exit request before its part hydrates", () => {
    expect(isPlanBuildApproval({ request: request(), answers: [["Build now"]], parts: [] })).toBe(true)
  })

  test("rejects a canonical-looking request linked to another tool", () => {
    expect(isPlanBuildApproval({ request: request(), answers: [["Build now"]], parts: [part("question")] })).toBe(
      false,
    )
  })

  test("rejects an unrelated Build now option and non-Build answers", () => {
    expect(
      isPlanBuildApproval({
        request: request({ ...canonicalQuestion, question: "Run the deployment now?" }),
        answers: [["Build now"]],
        parts: [],
      }),
    ).toBe(false)
    expect(isPlanBuildApproval({ request: request(), answers: [["Keep planning"]], parts: [] })).toBe(false)
  })
})
