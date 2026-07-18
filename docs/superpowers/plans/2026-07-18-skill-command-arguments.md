# Skill Command Argument Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display trimmed user-supplied arguments after a compact skill slash command while keeping expanded skill instructions hidden from the user timeline.

**Architecture:** Keep the existing `SessionPrompt.command` split between visible skill invocation text and synthetic expanded template parts. Build the visible text from `input.command` and `input.arguments.trim()`; leave ordinary commands, attachments, persisted schemas, and model-facing prompt content unchanged.

**Tech Stack:** TypeScript, Effect, Bun test runner

## Global Constraints

- Skill invocations with arguments display as `/<skill-name> <arguments>`.
- Remove only leading and trailing argument whitespace; preserve internal spaces and line breaks.
- Whitespace-only arguments display as `/<skill-name>`.
- Expanded skill instructions remain synthetic and available to the model.
- Ordinary slash commands and attachment handling remain unchanged.
- Do not change public API, Protocol, generated clients, desktop UI, or localization.
- Run tests and type checking from `packages/opencode`, never from the repository root.

---

### Task 1: Preserve Skill Arguments in Compact Command Display

**Files:**
- Modify: `packages/opencode/test/session/prompt.test.ts:1908`
- Modify: `packages/opencode/src/session/prompt.ts:1468`

**Interfaces:**
- Consumes: `SessionPrompt.command` input fields `command: string` and `arguments: string`.
- Produces: one non-synthetic `SessionV1.TextPart` containing the compact invocation; existing synthetic template parts remain unchanged.

- [ ] **Step 1: Write the failing regression test**

Replace the existing skill display test with these two complete cases. The first introduces the failing assertion; the second preserves empty-argument coverage:

```ts
it.instance("skill slash command shows user arguments and hides expanded instructions", () =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* writeText(
      path.join(dir, "skills", "superpowers-check", "SKILL.md"),
      [
        "---",
        "name: superpowers-check",
        "description: Test skill",
        "---",
        "# Superpowers Check",
        "",
        "Keep this instruction hidden.",
      ].join("\n"),
    )
    yield* writeConfig(dir, {
      ...providerCfg(llm.url),
      skills: { paths: [path.join(dir, "skills")] },
    })

    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("done")
    yield* prompt.command({
      sessionID: chat.id,
      command: "superpowers-check",
      arguments: "  Review the payment flow.\nKeep user context.  ",
    })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const message = messages.findLast((item) => item.info.role === "user")
    if (!message || message.info.role !== "user") throw new Error("expected user command message")
    const text = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

    expect(text.filter((part) => !part.synthetic).map((part) => part.text)).toEqual([
      "/superpowers-check Review the payment flow.\nKeep user context.",
    ])
    expect(text.find((part) => part.synthetic)?.text).toContain("# Superpowers Check")
    expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("# Superpowers Check")
  }),
)

it.instance("skill slash command omits whitespace-only arguments", () =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* writeText(
      path.join(dir, "skills", "superpowers-check", "SKILL.md"),
      [
        "---",
        "name: superpowers-check",
        "description: Test skill",
        "---",
        "# Superpowers Check",
        "",
        "Keep this instruction hidden.",
      ].join("\n"),
    )
    yield* writeConfig(dir, {
      ...providerCfg(llm.url),
      skills: { paths: [path.join(dir, "skills")] },
    })

    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("done")
    yield* prompt.command({ sessionID: chat.id, command: "superpowers-check", arguments: "  \n  " })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const message = messages.findLast((item) => item.info.role === "user")
    if (!message || message.info.role !== "user") throw new Error("expected user command message")
    const text = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

    expect(text.filter((part) => !part.synthetic).map((part) => part.text)).toEqual(["/superpowers-check"])
    expect(text.find((part) => part.synthetic)?.text).toContain("# Superpowers Check")
  }),
)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `packages/opencode`:

```powershell
& 'C:\Users\lahuman\AppData\Roaming\npm\bun.cmd' test test/session/prompt.test.ts --test-name-pattern "skill slash command"
```

Expected: FAIL because the visible text is `/superpowers-check` instead of `/superpowers-check Review the payment flow.\nKeep user context.`

- [ ] **Step 3: Implement the minimal display change**

Update only the visible skill text in `SessionPrompt.command`:

```ts
const commandParts =
  cmd.source === "skill"
    ? [
        {
          type: "text" as const,
          text: `/${input.command}${input.arguments.trim() ? ` ${input.arguments.trim()}` : ""}`,
        },
        ...uniqueTemplateParts.map((part) => (part.type === "text" ? { ...part, synthetic: true } : part)),
      ]
    : uniqueTemplateParts
```

- [ ] **Step 4: Run focused regression tests and verify GREEN**

Run from `packages/opencode`:

```powershell
& 'C:\Users\lahuman\AppData\Roaming\npm\bun.cmd' test test/session/prompt.test.ts --test-name-pattern "skill slash command|ordinary slash command"
```

Expected: all selected tests pass. The skill test proves visible arguments and hidden expanded instructions; the ordinary command test proves unchanged behavior.

- [ ] **Step 5: Run package type checking**

Run from `packages/opencode`:

```powershell
& 'C:\Users\lahuman\AppData\Roaming\npm\bun.cmd' typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 6: Review and commit the implementation**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' diff --check
& 'C:\Program Files\Git\cmd\git.exe' diff -- packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
& 'C:\Program Files\Git\cmd\git.exe' add -- packages/opencode/src/session/prompt.ts packages/opencode/test/session/prompt.test.ts
& 'C:\Program Files\Git\cmd\git.exe' commit -m 'fix(opencode): show skill command arguments'
```

Expected: a focused implementation commit containing only the session prompt behavior and its regression coverage.

### Task 2: Integrate and Reverify

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: the verified `skill-argument-display` branch.
- Produces: a non-fast-forward merge into local `enterprise-pilot`.

- [ ] **Step 1: Inspect branch scope and target divergence**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' status --short --branch
& 'C:\Program Files\Git\cmd\git.exe' diff --stat enterprise-pilot...HEAD
& 'C:\Program Files\Git\cmd\git.exe' diff --name-only --diff-filter=U
```

Expected: clean feature branch, only the design, plan, implementation, and test files in scope, with no unresolved conflicts.

- [ ] **Step 2: Merge into `enterprise-pilot`**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' switch enterprise-pilot
& 'C:\Program Files\Git\cmd\git.exe' merge --no-ff skill-argument-display -m 'merge: show skill command arguments'
```

Expected: merge completes without conflicts.

- [ ] **Step 3: Re-run focused tests and type checking on the merge result**

Run from `packages/opencode`:

```powershell
& 'C:\Users\lahuman\AppData\Roaming\npm\bun.cmd' test test/session/prompt.test.ts --test-name-pattern "skill slash command|ordinary slash command"
& 'C:\Users\lahuman\AppData\Roaming\npm\bun.cmd' typecheck
```

Expected: all selected tests pass and type checking exits with code 0.

- [ ] **Step 4: Confirm final repository state**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' status --short --branch
& 'C:\Program Files\Git\cmd\git.exe' log -4 --oneline --decorate
```

Expected: clean `enterprise-pilot` branch with the non-fast-forward merge at `HEAD`.
