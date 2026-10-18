import type { FormAnswer, FormInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"

const metadata = Schema.decodeUnknownOption(
  Schema.Struct({ tool: Schema.Struct({ messageID: Schema.String, id: Schema.String }) }),
)

export function isPlanBuildApproval(input: {
  request: FormInfo
  answer: FormAnswer
  tools: readonly { messageID: string; id: string; name: string }[]
}) {
  if (input.answer.q0 !== "Build now" || Object.keys(input.answer).length !== 1) return false
  const source = Option.getOrUndefined(metadata(input.request.metadata))?.tool
  if (!source) return false
  const linked = input.tools.find((tool) => tool.messageID === source.messageID && tool.id === source.id)
  if (linked) return linked.name === "plan_exit"
  const field = input.request.fields[0]
  if (input.request.fields.length !== 1 || field.type !== "string" || field.custom !== false) return false
  if (field.title !== "Build Agent" || field.description !== "The plan is ready. Would you like to switch to Build?")
    return false
  return (
    field.options?.length === 2 &&
    field.options[0]?.value === "Build now" &&
    field.options[0]?.description === "Switch to Build and send an implementation request" &&
    field.options[1]?.value === "Keep planning" &&
    field.options[1]?.description === "Stay in Plan mode and refine the plan"
  )
}
