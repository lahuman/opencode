# Skill Slash Command Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Show only the invoked `/<skill>` label in the user timeline while preserving the complete skill instructions in model context.

**Architecture:** Keep skill discovery and command templates unchanged. At the non-subtask boundary in `SessionPrompt.command`, prepend one ordinary visible text part and mark only the resolved skill-template text parts as synthetic. Existing message serialization already sends synthetic text to the model, while the session UI already omits it from visible user text.

**Tech Stack:** TypeScript, Effect, Bun test, OpenCode session and command services.

## Global Constraints

- Apply the behavior to every command whose `Command.Info.source` is `skill`; do not hardcode Ponytail, Caveman, or Superpowers names.
- Preserve ordinary slash commands, subtask commands, resolved file parts, command arguments, and the native `skill` tool behavior.
- Do not change public Protocol, `HttpApi`, schema, generated clients, Desktop UI, or i18n.
- Run tests and type checking from `packages/opencode`, never from the repository root.

---

### Task 1: Capture the compact skill-command contract

**Files:**

- Modify: `packages/opencode/test/session/prompt.test.ts`

- [ ] Add an integration test near the existing slash-command tests. The test creates a discovered skill before booting the services, invokes it through `SessionPrompt.command`, and inspects the persisted user message and actual LLM request.

```ts
it.instance("skill slash command hides expanded instructions from the user timeline", () =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* writeText(
      path.join(dir, "skills", "superpowers-check", "SKILL.md"),
      "---\nname: superpowers-check\ndescription: Test skill\n---\n# Superpowers Check\n\nKeep this instruction hidden.",
    )
    yield* writeConfig(dir, {
      ...providerCfg(llm.url),
      skills: { paths: [path.join(dir, "skills")] },
    })

    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("done")
    yield* prompt.command({ sessionID: chat.id, command: "superpowers-check", arguments: "" })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const message = messages.findLast((item) => item.info.role === "user")
    if (!message || message.info.role !== "user") throw new Error("expected user command message")
    const text = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

    expect(text.filter((part) => !part.synthetic).map((part) => part.text)).toEqual(["/superpowers-check"])
    expect(text.find((part) => part.synthetic)?.text).toContain("# Superpowers Check")
    expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("# Superpowers Check")
  }),
)
```

The final test may adjust setup order or config construction to match the fixture’s actual instance caching rules, but must assert the same three boundaries: one visible label, synthetic full instructions, full instructions in model input.

- [ ] Add a regression assertion for an ordinary configured command, proving its expanded template remains the visible non-synthetic user text.

```ts
expect(text.filter((part) => !part.synthetic).map((part) => part.text)).toEqual(["Ordinary expanded prompt"])
expect(text.some((part) => part.synthetic)).toBe(false)
```

- [ ] Run the new focused test and confirm the skill assertion fails for the intended reason before changing production code.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test test/session/prompt.test.ts --test-name-pattern "skill slash command"
```

Expected: failure showing the expanded skill template is currently the non-synthetic visible text, or that `/${command}` is absent.

---

### Task 2: Split visible skill labels from synthetic instructions

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts:1461`

- [ ] In the non-subtask branch of `SessionPrompt.command`, transform only `cmd.source === "skill"` parts. Keep `templateParts` unchanged for the subtask prompt path.

```ts
const commandParts =
  cmd.source === "skill"
    ? [
        { type: "text" as const, text: `/${input.command}` },
        ...uniqueTemplateParts.map((part) => (part.type === "text" ? { ...part, synthetic: true } : part)),
      ]
    : uniqueTemplateParts
const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
const parts = isSubtask
  ? [
      {
        type: "subtask" as const,
        agent: agent.name,
        description: cmd.description ?? "",
        command: input.command,
        model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
        prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
      },
    ]
  : [...commandParts, ...(input.parts ?? [])]
```

- [ ] Keep resolved file parts unchanged: only `type === "text"` parts receive `synthetic: true`.
- [ ] Keep plugin hooks receiving the final `parts` array, so plugins observe the same payload that is persisted and sent to the prompt pipeline.
- [ ] Run the focused test again.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test test/session/prompt.test.ts --test-name-pattern "skill slash command"
```

Expected: pass.

---

### Task 3: Verify compatibility and repository quality

**Files:**

- Verify: `packages/opencode/src/session/prompt.ts`
- Verify: `packages/opencode/test/session/prompt.test.ts`
- Verify: `docs/superpowers/specs/2026-07-17-skill-command-display-design.md`

- [ ] Run all slash-command-focused tests in the prompt suite.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test test/session/prompt.test.ts --test-name-pattern "command|slash command"
```

Expected: pass with no regressions in ordinary commands, shell expansion, or subtask command cancellation.

- [ ] Run the complete prompt test file.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test test/session/prompt.test.ts
```

Expected: pass.

- [ ] Run package type checking.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

Expected: exit code 0.

- [ ] Review the diff for scope. Confirm there are no public API, schema, generated-client, Desktop, or i18n changes.

```powershell
& "C:\Program Files\Git\cmd\git.exe" diff --check
& "C:\Program Files\Git\cmd\git.exe" diff -- packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
```

- [ ] Commit the implementation after verification.

```powershell
& "C:\Program Files\Git\cmd\git.exe" add packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
& "C:\Program Files\Git\cmd\git.exe" commit -m "fix(opencode): compact skill command display"
```

---

### Task 4: Integrate into `enterprise-pilot`

**Files:** none beyond Git history.

- [ ] Compare the feature branch with `enterprise-pilot` and confirm there are no unresolved conflicts.

```powershell
& "C:\Program Files\Git\cmd\git.exe" diff --check enterprise-pilot...HEAD
& "C:\Program Files\Git\cmd\git.exe" diff --stat enterprise-pilot...HEAD
```

- [ ] Switch to `enterprise-pilot` and merge with a merge commit.

```powershell
& "C:\Program Files\Git\cmd\git.exe" switch enterprise-pilot
& "C:\Program Files\Git\cmd\git.exe" merge --no-ff skill-command-display
```

- [ ] From `packages/opencode`, rerun the focused prompt test and `bun typecheck` on the merged state.

```powershell
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd test test/session/prompt.test.ts --test-name-pattern "skill slash command"
C:\Users\lahuman\AppData\Roaming\npm\bun.cmd typecheck
```

- [ ] Do not push or create a PR.
