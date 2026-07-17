# Skill Slash Command Display Design

## Goal

When a skill is invoked as a slash command, keep the complete skill instructions in model context while showing only the invoked command, such as `/ponytail` or `/brainstorming`, in the user timeline.

## Design

`Command.Service` continues to register every discovered skill as a slash command and continues to provide the complete skill template. During `SessionPrompt.command`, commands whose source is `skill` split the resolved text into two parts:

- a visible text part containing `/${input.command}`;
- the expanded skill text marked `synthetic: true`.

Synthetic text already remains in `MessageV2.toModelMessagesEffect`, while `UserMessage` rendering excludes synthetic text. This preserves model behavior without adding a new schema, API, renderer, or skill-pack-specific branch. Ponytail, Caveman, Superpowers, and separately installed skills receive the same behavior.

Non-skill slash commands, native `skill` tool calls, file parts, arguments, and subtask commands retain their current behavior. Skill commands that resolve file references keep those file parts unchanged; only expanded text parts become synthetic.

## Verification

- Add a command integration regression test that invokes a real discovered skill and asserts the stored user message has `/${command}` as its visible text and the full template as synthetic text.
- Assert model input still contains the full skill instructions.
- Assert an ordinary slash command continues to store and display its expanded template normally.
- Run focused command/session tests and `bun typecheck` from `packages/opencode`.

## Compatibility

No public Protocol or `HttpApi` shape changes are required, so client generation is unnecessary. Existing histories are not migrated; only newly invoked skill commands use the compact display.
