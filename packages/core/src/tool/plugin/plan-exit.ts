export * as PlanExitTool from "./plan-exit.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"

export const Input = Schema.Struct({ plan: Schema.NonEmptyString })
const Output = Schema.Struct({ agent: Schema.Literals(["plan", "build"]) })

export const Plugin = {
  id: "opencode.tool.plan-exit",
  effect: Effect.fn("PlanExitTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    yield* ctx.session.hook("context", (event) => {
      if (event.agent !== "plan") delete event.tools.plan_exit
      return Effect.void
    })
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "plan_exit",
        options: { codemode: false },
        description:
          "Only use this tool when the user explicitly requests implementation or command execution and the proposed work is ready for approval. Present the complete Markdown plan and ask whether to switch to Build. Do not use this tool for analysis, explanations, reviews, or planning-only requests. Only the user's explicit choice in the approval form starts implementation; typing Build now in chat is not required for analysis.",
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            if (context.agent !== "plan")
              return yield* Effect.fail(new ToolFailure({ message: "plan_exit is only available in Plan mode" }))
            yield* permission
              .assert({
                action: "plan_exit",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: plan_exit", error })))
            const state = yield* forms
              .ask({
                sessionID: context.sessionID,
                title: "Build Agent",
                metadata: { kind: "question", tool: { messageID: context.messageID, id: context.id } },
                fields: [
                  {
                    key: "q0",
                    title: "Build Agent",
                    description: "The plan is ready. Would you like to switch to Build?",
                    type: "string",
                    custom: false,
                    options: [
                      {
                        value: "Build now",
                        label: "Build now",
                        description: "Switch to Build and send an implementation request",
                      },
                      {
                        value: "Keep planning",
                        label: "Keep planning",
                        description: "Stay in Plan mode and refine the plan",
                      },
                    ],
                  },
                ],
              })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to request plan approval", error })))
            if (state.status !== "answered" || state.answer.q0 !== "Build now")
              return {
                output: { agent: "plan" as const },
                content:
                  "The user did not approve implementation. Stay in Plan mode and wait for their next request. Read-only analysis does not require Build approval. Do not request Build approval again unless the user explicitly asks for implementation or command execution.",
                metadata: { agent: "plan" },
              }
            yield* sessions
              .switchAgent({ sessionID: context.sessionID, agent: Agent.defaultID })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to switch to Build", error })))
            yield* sessions
              .prompt({
                sessionID: context.sessionID,
                text: `The following plan has been approved. Implement it now.\n\n${input.plan.trim()}`,
                delivery: "steer",
                resume: false,
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Unable to admit the approved plan", error })),
              )
            return {
              output: { agent: "build" as const },
              content: "Starting Build agent to implement the approved plan.",
              metadata: { agent: "build" },
            }
          }),
      }),
    )
  }),
}
