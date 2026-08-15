import type { Part, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

const canonical = {
  header: "Build Agent",
  question: "The plan is ready. Would you like to switch to Build?",
  options: [
    { label: "Build now", description: "Switch to Build and send an implementation request" },
    { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
  ],
}

export function isPlanBuildApproval(input: {
  request: QuestionRequest
  answers: QuestionAnswer[]
  parts: Part[]
}) {
  const answer = input.answers[0]
  const tool = input.request.tool
  if (!tool || input.answers.length !== 1 || answer?.length !== 1 || answer[0] !== "Build now") return false

  const linked = input.parts.find(
    (part) => part.type === "tool" && part.messageID === tool.messageID && part.callID === tool.callID,
  )
  if (linked?.type === "tool") return linked.tool === "plan_exit"

  const question = input.request.questions[0]
  if (input.request.questions.length !== 1 || !question) return false
  if (question.header !== canonical.header || question.question !== canonical.question) return false
  if (question.custom !== false || question.multiple === true || question.options.length !== 2) return false

  return question.options.every(
    (option, index) =>
      option.label === canonical.options[index]?.label && option.description === canonical.options[index]?.description,
  )
}
