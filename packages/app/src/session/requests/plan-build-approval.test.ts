import { expect, test } from "bun:test"
import type { FormInfo } from "@opencode/client/promise"
import { isPlanBuildApproval } from "./plan-build-approval"

const request: FormInfo = {
  id: "form-plan",
  sessionID: "session-plan",
  title: "Build Agent",
  metadata: { kind: "question", tool: { messageID: "message-plan", id: "call-plan" } },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Build Agent",
      description: "The plan is ready. Would you like to switch to Build?",
      custom: false,
      options: [
        { value: "Build now", label: "Build now", description: "Switch to Build and send an implementation request" },
        { value: "Keep planning", label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
      ],
    },
  ],
}

test.each([
  {
    name: "linked Plan tool",
    tools: [{ messageID: "message-plan", id: "call-plan", name: "plan_exit" }],
    expected: true,
  },
  { name: "canonical form before tool hydration", tools: [], expected: true },
  {
    name: "another linked tool",
    tools: [{ messageID: "message-plan", id: "call-plan", name: "question" }],
    expected: false,
  },
])("recognizes $name", (row) => {
  expect(isPlanBuildApproval({ request, answer: { q0: "Build now" }, tools: row.tools })).toBe(row.expected)
  expect(isPlanBuildApproval({ request, answer: { q0: "Keep planning" }, tools: row.tools })).toBe(false)
})

test("rejects unrelated or custom Build now questions", () => {
  expect(
    isPlanBuildApproval({
      request: { ...request, fields: [{ ...request.fields[0], description: "Deploy now?" }] },
      answer: { q0: "Build now" },
      tools: [],
    }),
  ).toBe(false)
  expect(isPlanBuildApproval({ request: { ...request, metadata: {} }, answer: { q0: "Build now" }, tools: [] })).toBe(
    false,
  )
})
