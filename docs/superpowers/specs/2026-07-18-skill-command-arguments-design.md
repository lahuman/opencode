# Skill Command Argument Display Design

## Goal

Show the content a user supplies after a skill slash command while keeping the expanded skill instructions out of the user-visible timeline.

## Behavior

- A skill invocation with arguments is displayed as `/<skill-name> <arguments>`.
- Leading and trailing whitespace is removed from the argument string.
- Whitespace inside the argument string, including line breaks, is preserved.
- A skill invocation with empty or whitespace-only arguments is displayed as `/<skill-name>`.
- Expanded skill instructions remain synthetic text parts. They continue to be available to the model but are not rendered as the user's command text.
- Input attachments remain separate message parts and are not duplicated in the command display.
- Ordinary slash commands retain their current expanded-template display behavior.

## Architecture and Data Flow

`SessionPrompt.command` already distinguishes skill-backed commands from ordinary commands after resolving the command template. For a skill command, it will derive the visible text directly from `input.command` and `input.arguments.trim()`. The resolved skill template remains in synthetic text parts, followed by any input attachment parts.

This keeps the change inside the existing session prompt boundary. It requires no public API, Protocol, persisted-message schema, desktop UI, or localization changes.

## Alternatives Considered

1. **Compose the existing visible command text in `SessionPrompt.command` (selected).** This is the smallest change and applies consistently to every native skill-backed slash command.
2. **Add a second visible text part for arguments.** The current UI selects the first non-synthetic text part, so this would require renderer changes and could fragment copied command text.
3. **Add invocation-display metadata to the message schema.** This would make presentation explicit but would introduce unnecessary Protocol and client-generation work for a string already available at command admission.

## Error and Edge-Case Handling

No new failure path is introduced. Argument display uses the already-validated string in the command input. Whitespace-only arguments collapse to the no-argument form, while internal formatting remains intact. Skill template resolution, missing-command handling, and attachment deduplication retain their existing behavior.

## Verification

- Extend the existing skill slash-command regression test with surrounding whitespace and multiline arguments.
- Assert the only non-synthetic text is the compact command plus trimmed user arguments.
- Assert the synthetic part still contains the expanded skill instructions and that the model input still receives them.
- Add or retain coverage for an empty argument string displaying only `/<skill-name>`.
- Run the focused session prompt test and `bun typecheck` from `packages/opencode`.

## Scope

This change affects only the visible text for skill-backed slash commands. It does not alter skill discovery, skill loading, command parsing, prompt expansion, attachments, ordinary slash commands, public APIs, or desktop rendering.
