export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import type { SessionEvent } from "@opencode/schema/session-event"
import { Global } from "@opencode/util/global"
import { Effect, Stream } from "effect"
import path from "path"
import { Permission } from "../permission.js"
import { Enterprise } from "../enterprise.js"

const plan = Agent.ID.make("plan")
const readonlyTools = new Set([
  "git_diff",
  "glob",
  "grep",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "plan_exit",
  "question",
  "read",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
])

const enter = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. ${Enterprise.enabled() ? "Do not create or modify any files. Keep the complete plan in the conversation." : `Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:\n${directory}`}

Do not modify any other files or ask a subagent to do so.

Follow the user's requested outcome:
- For analysis, explanation, review, or investigation requests, use the available read-only tools and answer with your findings. Do not call plan_exit or require Build approval for these requests.
- For planning-only requests, present the requested plan in the conversation and finish in Plan mode. A completed plan alone is not a request to implement it.
- If a tool or command is unavailable in Plan mode, explain that specific limitation and continue all available read-only analysis. Do not make Build approval a prerequisite for the entire analysis.
- Only when the user explicitly requests implementation or command execution, complete the available read-only investigation, present the proposed work, and call plan_exit with the complete Markdown plan.

Only the user's explicit "Build now" choice in the approval form authorizes switching to Build and implementation. Do not ask the user to type "Build now" in chat to enable analysis. If they keep planning or dismiss the question, remain in Plan mode and wait for their next request. Do not request Build approval again unless the user explicitly asks for implementation or command execution.
</system-reminder>`

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const directory = path.join(global.home, ".opencode", "plan")
    const enterReminder = enter(directory)
    yield* ctx.agent.transform((editor) => {
      editor.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for analyzing, explaining, and reviewing code, or planning work."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "plan_exit", resource: "*", effect: "allow" })
        item.permissions.push({ action: "git_diff", resource: "*", effect: "allow" })
        item.permissions.push({ action: "shell", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: path.join(directory, "*"), effect: "allow" })
      })
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      return Effect.void
    })
    yield* ctx.tool.hook("execute.before", (event) => {
      if (!Enterprise.enabled() || event.agent !== plan || readonlyTools.has(event.tool)) return Effect.void
      return Effect.fail(
        new Tool.Error({
          message: `Cannot use ${event.tool} in Plan mode. Continue read-only analysis with read, glob, grep, or git_diff. Request Build approval only when the user explicitly asks for implementation or command execution.`,
        }),
      )
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    yield* ctx.session.hook("context", (event) => {
      if (Enterprise.enabled() && event.agent === plan)
        Object.keys(event.tools)
          .filter((name) => !readonlyTools.has(name))
          .forEach((name) => delete event.tools[name])
      const reminder = lastReminder(event.messages)
      const missing = event.agent === plan && reminder !== enterReminder
      const stale = event.agent !== plan && reminder !== undefined && reminder !== leave
      const text = missing ? enterReminder : stale ? leave : undefined
      if (!text) return Effect.void
      // Before the user's prompt, matching where agent-switch reminders land.
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      event.messages.splice(at, 0, Message.user(text))
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist Plan mode reminder", { sessionID: event.sessionID, cause }),
          ),
        )
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Created | SessionEvent.AgentSelected =>
          event.type === "session.created" || event.type === "session.agent.selected",
      ),
      Stream.runForEach((event) => {
        const text = switchReminder(event, enterReminder)
        if (!text) return Effect.void
        return ctx.session
          .synthetic({
            sessionID: event.data.sessionID,
            text,
            resume: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
            ),
          )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function switchReminder(
  event: SessionEvent.Created | SessionEvent.AgentSelected,
  enterReminder: string,
): string | undefined {
  if (event.type === "session.created") {
    if (event.data.agent !== plan) return undefined
    return enterReminder
  }
  if (event.data.agent === event.data.previous) return undefined
  if (event.data.agent === plan) return enterReminder
  if (event.data.previous === plan) return leave
  return undefined
}

function lastReminder(messages: ReadonlyArray<Message>) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    const entered =
      part.text.startsWith("<system-reminder>\nYou are in Plan mode. ") && part.text.endsWith("\n</system-reminder>")
    return entered || part.text === leave ? part.text : found
  }, undefined)
}
