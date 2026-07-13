# Company Guidance Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle a versioned company guide, apply project-adjustable safety defaults, and remove remaining public help, prompt, instruction, and renderer network behavior from the enterprise profile.

**Architecture:** The packaged guide is referenced by the low-priority enterprise config and displayed through a desktop platform API. Enterprise runtime flags select a neutral offline system prompt, skip URL instructions, enforce default permission rules, and block renderer/main-process URL opening outside loopback and packaged internal origins.

**Tech Stack:** Electron IPC, SolidJS, Effect runtime flags, OpenCode instruction and permission services, existing desktop menu and Markdown components.

## Global Constraints

- Complete the offline foundation and Company LLM connection plans first.
- The guide and harness are adjustable project defaults, not immutable security controls.
- Build-level public-service gates and provider-origin restrictions remain non-overridable.
- The guide must be readable without internet access and must expose a version.
- External web search and URL fetch are denied by default.
- Project-external files, secret files, and destructive shell commands require confirmation by default.
- Policy logs must not record prompts, file contents, API keys, secret headers, or environment values.
- Ordinary desktop and web builds retain existing help links and release-note behavior.
- Run tests and `bun typecheck` from package directories.

---

### Task 1: Bundle and load the versioned company guide

**Files:**
- Create: `packages/desktop/resources/enterprise/company-guide.md`
- Modify: `packages/desktop/src/enterprise.ts`
- Modify: `packages/desktop/src/enterprise.test.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Modify: `packages/desktop/src/main/env.d.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/opencode/src/config/enterprise.ts`
- Modify: `packages/opencode/test/config/config.test.ts`

**Interfaces:**
- Extends `EnterpriseProfile` with `defaultsVersion` and `guideVersion`.
- Supplies `OPENCODE_ENTERPRISE_GUIDE_PATH`, `OPENCODE_ENTERPRISE_DEFAULTS_VERSION`, and `OPENCODE_ENTERPRISE_GUIDE_VERSION` to the sidecar.
- Adds the absolute guide path to parsed enterprise default `instructions` without raw JSON text substitution.
- Adds defaults and guide versions to the metadata-safe desktop startup log so exported diagnostics identify all three release versions.

- [ ] **Step 1: Extend profile tests for version metadata and guide path**

Add the two required build variables to every enabled-profile fixture in `enterprise.test.ts` so validation failures still reach their intended field. Extend the successful environment fixture with:

```ts
const profile = parseEnterpriseProfile({
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
})

expect(
  enterpriseEnvironment(profile, {
    defaults: "C:/app/enterprise/opencode.jsonc",
    guide: "C:/app/enterprise/company-guide.md",
  }),
).toMatchObject({
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_PATH: "C:/app/enterprise/company-guide.md",
})
```

Add a config precedence test proving the bundled guide is first and project instructions are appended:

```ts
expect((yield* Config.use.get()).instructions).toEqual([
  enterpriseGuide,
  "project-guide.md",
])
```

The test environment must include the same Company LLM base URL, model ID, model name, allowed origin, defaults path, and absolute guide path used by `ConfigEnterprise.materializeDefaults`.

- [ ] **Step 2: Run focused tests and verify failure**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts
```

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts --filter "bundled guide"
```

Expected: FAIL because version fields and the guide instruction are absent.

- [ ] **Step 3: Add version fields and the baseline guide**

Require both version variables in `parseEnterpriseProfile`, include them in the enabled profile, expose them through `enterpriseEnvironment`, and define them for main and renderer in `electron.vite.config.ts`.

Create `company-guide.md`:

```markdown
# 사내 AI 활용 기본 가이드

1. 회사가 승인한 업무와 데이터만 사내 LLM에 입력합니다.
2. 개인정보, 인증정보, 비밀키, 고객 기밀은 프롬프트와 소스 코드에 직접 포함하지 않습니다.
3. 모델이 생성한 코드와 설명은 담당자가 검토하고 테스트한 뒤 사용합니다.
4. 외부 웹 서비스, 외부 모델, 공개 공유 기능으로 회사 데이터를 전송하지 않습니다.
5. 파일 수정과 명령 실행 전에 변경 범위와 영향을 확인합니다.
6. 프로젝트별 추가 지침은 프로젝트 `opencode.jsonc` 또는 `AGENTS.md`에 기록합니다.
7. 보안 사고 가능성이 있으면 작업을 중단하고 회사의 보안 보고 절차를 따릅니다.
```

Extend `ConfigEnterprise.settings()` with `guidePath` from `OPENCODE_ENTERPRISE_GUIDE_PATH`. Extend `materializeDefaults` to prepend the absolute `guidePath` to its parsed `instructions` array when present, deduplicating it if the file already lists the same path. Do not place the Windows path in an `{env:...}` JSONC token; config token substitution is textual and backslashes would corrupt JSON on Windows.

After logging the application version in `src/main/index.ts`, add:

```ts
if (ENTERPRISE_PROFILE.enabled) {
  logger.log("enterprise profile", {
    defaultsVersion: ENTERPRISE_PROFILE.defaultsVersion,
    guideVersion: ENTERPRISE_PROFILE.guideVersion,
  })
}
```

Do not log the provider URL, credentials, headers, prompts, or guide contents.

- [ ] **Step 4: Run guide/config tests and typechecks**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts
bun typecheck
```

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts --filter "bundled guide"
bun typecheck
```

Expected: tests PASS and both typechecks exit 0.

- [ ] **Step 5: Commit the bundled guide**

```bash
git add packages/desktop/resources/enterprise/company-guide.md packages/desktop/src/enterprise.ts packages/desktop/src/enterprise.test.ts packages/desktop/electron.vite.config.ts packages/desktop/src/main/env.d.ts packages/desktop/src/main/index.ts packages/opencode/src/config/enterprise.ts packages/opencode/test/config/config.test.ts
git commit -m "feat(desktop): bundle company ai guide"
```

### Task 2: Apply the offline prompt and default permission harness

**Files:**
- Create: `packages/opencode/src/session/prompt/enterprise.txt`
- Modify: `packages/opencode/src/session/system.ts`
- Modify: `packages/opencode/src/session/llm/request.ts`
- Modify: `packages/opencode/src/session/instruction.ts`
- Modify: `packages/opencode/src/permission/index.ts`
- Modify: `packages/desktop/resources/enterprise/opencode.jsonc`
- Modify: `packages/opencode/test/session/system.test.ts`
- Modify: `packages/opencode/test/config/config.test.ts`
- Modify: `packages/opencode/test/permission/next.test.ts`

**Interfaces:**
- Consumes `RuntimeFlags.Info.enterpriseOffline` from the offline foundation.
- Changes `SystemPrompt.provider(model, enterpriseOffline)` to return the offline prompt in enterprise mode.
- Makes `Instruction.system()` ignore all URL instructions when enterprise mode is active.
- Adds only metadata-safe permission reply logs.

- [ ] **Step 1: Write failing prompt, instruction, and permission-default tests**

Add to `test/session/system.test.ts`:

```ts
test("enterprise provider prompt contains no public URLs or web-fetch instruction", () => {
  const prompt = SystemPrompt.provider({ api: { id: "company-code" } } as Provider.Model, true).join("\n")
  expect(prompt).not.toContain("https://")
  expect(prompt).not.toContain("WebFetch")
  expect(prompt).toContain("company-provided instructions")
})
```

Add to `test/config/config.test.ts` with enterprise defaults loaded:

```ts
expect(config.permission).toMatchObject({
  webfetch: "deny",
  websearch: "deny",
  external_directory: "ask",
})
```

Add to `test/permission/next.test.ts`:

```ts
test("enterprise harness patterns keep safe commands allowed and ask on destructive commands", () => {
  const rules = Permission.fromConfig({
    bash: {
      "*": "allow",
      "rm -rf *": "ask",
      "git reset --hard*": "ask",
      "git clean -fd*": "ask",
    },
  })
  expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  expect(Permission.evaluate("bash", "rm -rf build", rules).action).toBe("ask")
  expect(Permission.evaluate("bash", "git reset --hard HEAD", rules).action).toBe("ask")
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run from `packages/opencode`:

```bash
bun test test/session/system.test.ts test/permission/next.test.ts test/config/config.test.ts --filter "enterprise"
```

Expected: FAIL because the enterprise prompt and harness defaults are absent.

- [ ] **Step 3: Add a neutral offline system prompt**

Create `session/prompt/enterprise.txt`:

```text
You are the company's local coding assistant. Work only with the available local project context, company-provided instructions, configured internal services, and explicitly approved tools.

Do not ask the user to visit public OpenCode services. Do not use external web search or URL fetching unless the effective project permissions explicitly allow it. Treat model output as a proposal that must be reviewed and tested before use.

Be concise and state what local files or commands you use. Ask for confirmation when a permission rule requires it. Never include credentials, secret header values, or environment-variable values in logs or final responses.
```

Import the new prompt in `session/system.ts` and change the signature:

```ts
export function provider(model: Provider.Model, enterpriseOffline = false) {
  if (enterpriseOffline) return [PROMPT_ENTERPRISE]
  // existing provider selection remains unchanged below
}
```

In `session/llm/request.ts`, call:

```ts
SystemPrompt.provider(input.model, input.flags.enterpriseOffline)
```

- [ ] **Step 4: Disable URL instructions and add harness defaults**

In `Instruction.system()`, choose no URLs in enterprise mode:

```ts
const urls = flags.enterpriseOffline
  ? []
  : (config.instructions ?? []).filter((item) => item.startsWith("https://") || item.startsWith("http://"))
```

Add to the enterprise `opencode.jsonc`, preserving key order because permission precedence is order-sensitive:

```jsonc
"permission": {
  "webfetch": "deny",
  "websearch": "deny",
  "external_directory": "ask",
  "read": {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow"
  },
  "bash": {
    "*": "allow",
    "rm -rf *": "ask",
    "git reset --hard*": "ask",
    "git clean -fd*": "ask"
  }
}
```

After locating a pending permission in `reply`, add one metadata-only log:

```ts
yield* Effect.logInfo("permission replied", {
  permission: existing.info.permission,
  reply: input.reply,
  patternCount: existing.info.patterns.length,
})
```

Do not log `metadata`, patterns, prompt text, feedback text, or tool input.

- [ ] **Step 5: Run harness tests and opencode typecheck**

Run from `packages/opencode`:

```bash
bun test test/session/system.test.ts test/permission/next.test.ts test/config/config.test.ts --filter "enterprise"
bun typecheck
```

Expected: selected tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the guide harness**

```bash
git add packages/opencode/src/session/prompt/enterprise.txt packages/opencode/src/session/system.ts packages/opencode/src/session/llm/request.ts packages/opencode/src/session/instruction.ts packages/opencode/src/permission/index.ts packages/desktop/resources/enterprise/opencode.jsonc packages/opencode/test/session/system.test.ts packages/opencode/test/config/config.test.ts packages/opencode/test/permission/next.test.ts
git commit -m "feat(opencode): add company guidance harness"
```

### Task 3: Expose local guide help and remove public help links

**Files:**
- Create: `packages/app/src/components/dialog-company-guide.tsx`
- Modify: `packages/app/src/context/platform.tsx`
- Modify: `packages/app/src/app.tsx`
- Modify: `packages/app/src/desktop-menu.ts`
- Modify: `packages/app/src/desktop-menu.test.ts`
- Modify: `packages/app/src/components/windows-app-menu.tsx`
- Modify: `packages/app/src/components/help-button.tsx`
- Modify: `packages/app/src/components/settings-general.tsx`
- Modify: `packages/app/src/components/settings-v2/general.tsx`
- Modify: `packages/app/src/pages/error.tsx`
- Modify: `packages/app/src/pages/home.tsx`
- Modify: `packages/app/src/pages/layout.tsx`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`

**Interfaces:**
- Extends `Platform.enterprise` with `readGuide(): Promise<{ version: string; markdown: string }>`.
- Adds command `company.guide.open`.
- Adds menu visibility `edition?: "public" | "enterprise"`.

- [ ] **Step 1: Write failing edition-menu tests**

Add to `desktop-menu.test.ts`:

```ts
import { desktopMenuForEdition } from "./desktop-menu"

test("enterprise help menu contains only local guide and log export", () => {
  const help = desktopMenuForEdition("enterprise").find((menu) => menu.id === "help")
  expect(help?.items?.filter((item) => item.type === "item").map((item) => item.label)).toEqual([
    "Company AI Guide",
    "Export Logs...",
  ])
  expect(help?.items?.some((item) => item.type === "item" && "href" in item && item.href)).toBe(false)
})

test("public help menu keeps OpenCode links", () => {
  expect(desktopMenuForEdition("public").find((menu) => menu.id === "help")?.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ href: "https://opencode.ai/docs" })]),
  )
})
```

- [ ] **Step 2: Run the menu test and verify failure**

Run from `packages/app`:

```bash
bun test src/desktop-menu.test.ts
```

Expected: FAIL because `desktopMenuForEdition` does not exist.

- [ ] **Step 3: Add guide IPC and platform methods**

Add this method to the existing enterprise credential IPC surface:

```ts
readGuide: () => ipcRenderer.invoke("enterprise-guide-read")
```

The main handler reads the already-resolved guide path with `readFile(path, "utf8")` and returns:

```ts
{
  version: ENTERPRISE_PROFILE.enabled ? ENTERPRISE_PROFILE.guideVersion : "",
  markdown,
}
```

Reject the call when enterprise mode is disabled. Map the method through `Platform.enterprise` in the renderer.

- [ ] **Step 4: Add the local guide dialog and command**

Create `DialogCompanyGuide` using the existing `Dialog` and `@opencode-ai/session-ui/markdown` `Markdown` component. It receives `{ version, markdown }`, uses `Company AI Guide` as the title, shows `Version ${version}` in compact secondary text, and renders the Markdown in a scrollable body.

In `DesktopCommands`, register:

```ts
if (platform.enterprise) {
  commands.push({
    id: "company.guide.open",
    title: "Company AI Guide",
    category: language.t("command.category.settings"),
    onSelect: () => {
      void platform.enterprise?.readGuide().then((guide) => dialog.show(() => <DialogCompanyGuide {...guide} />))
    },
  })
}
```

Add `edition` metadata to menu entries, implement `desktopMenuForEdition`, and use it in both the Windows menu and native menu. The enterprise Help menu contains `Company AI Guide`, `Export Logs...`, and no `href` items.

Change help buttons and error/home/layout help callbacks to trigger `company.guide.open` in enterprise mode. Hide external theme documentation links in both settings layouts when `platform.enterprise` is present.

- [ ] **Step 5: Run app and desktop verification**

Run from `packages/app`:

```bash
bun test src/desktop-menu.test.ts
bun typecheck
```

Run from `packages/desktop`:

```bash
bun typecheck
```

Expected: menu tests PASS and both typechecks exit 0.

- [ ] **Step 6: Commit local help**

```bash
git add packages/app/src/components/dialog-company-guide.tsx packages/app/src/context/platform.tsx packages/app/src/app.tsx packages/app/src/desktop-menu.ts packages/app/src/desktop-menu.test.ts packages/app/src/components/windows-app-menu.tsx packages/app/src/components/help-button.tsx packages/app/src/components/settings-general.tsx packages/app/src/components/settings-v2/general.tsx packages/app/src/pages/error.tsx packages/app/src/pages/home.tsx packages/app/src/pages/layout.tsx packages/desktop/src/main/index.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.ts packages/desktop/src/renderer/index.tsx
git commit -m "feat(app): add local company help"
```

### Task 4: Block public renderer and external-link traffic

**Files:**
- Modify: `packages/desktop/src/enterprise.ts`
- Modify: `packages/desktop/src/enterprise.test.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/windows.ts`
- Modify: `packages/desktop/src/renderer/index.tsx`
- Modify: `packages/app/src/context/highlights.tsx`
- Create: `packages/app/src/context/highlights.test.ts`

**Interfaces:**
- Produces: `enterpriseURLAllowed(profile, input)` for renderer fetch, renderer link handling, and main-process external opening.
- Produces: `enterpriseRendererRequestAllowed(profile, input)` for the Electron session request boundary.
- Produces: `shouldLoadReleaseHighlights(enterprise)`.

- [ ] **Step 1: Write failing URL and changelog tests**

Add to `enterprise.test.ts`:

```ts
// Extend the existing import from "./enterprise" with both URL policy helpers.
test("allows loopback and packaged provider origins only", () => {
  const profile = parseEnterpriseProfile({
    OPENCODE_ENTERPRISE: "1",
    OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
    OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
    OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
    OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
    OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  })
  expect(enterpriseURLAllowed(profile, "http://127.0.0.1:4096/global/health")).toBe(true)
  expect(enterpriseURLAllowed(profile, "https://llm.corp.example/v1/chat/completions")).toBe(true)
  expect(enterpriseURLAllowed(profile, "https://opencode.ai/changelog.json")).toBe(false)
  expect(enterpriseRendererRequestAllowed(profile, "opencode://app/index.html")).toBe(true)
  expect(enterpriseRendererRequestAllowed(profile, "data:image/png;base64,AA==")).toBe(true)
  expect(enterpriseRendererRequestAllowed(profile, "https://cdn.example/image.png")).toBe(false)
})
```

Create `highlights.test.ts`:

```ts
import { expect, test } from "bun:test"
import { shouldLoadReleaseHighlights } from "./highlights"

test("enterprise edition never loads public release highlights", () => {
  expect(shouldLoadReleaseHighlights(true)).toBe(false)
  expect(shouldLoadReleaseHighlights(false)).toBe(true)
})
```

- [ ] **Step 2: Run tests and verify failure**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts
```

Run from `packages/app`:

```bash
bun test src/context/highlights.test.ts
```

Expected: FAIL because both pure helpers are missing.

- [ ] **Step 3: Implement URL policy at both process boundaries**

```ts
export function enterpriseURLAllowed(profile: EnterpriseProfile, input: string | URL) {
  if (!profile.enabled) return true
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") return true
    return profile.allowedOrigins.includes(url.origin)
  } catch {
    return false
  }
}

export function enterpriseRendererRequestAllowed(profile: EnterpriseProfile, input: string | URL) {
  if (!profile.enabled) return true
  try {
    const url = new URL(input)
    if (url.protocol === "opencode:" || url.protocol === "data:" || url.protocol === "blob:") return true
    return enterpriseURLAllowed(profile, url)
  } catch {
    return false
  }
}
```

In renderer `platform.openLink`, reject disallowed URLs without calling IPC. In renderer `platform.fetch`, evaluate both `Request.url` and string/URL inputs, then return a rejected promise with `Enterprise offline policy blocked ${url.origin}` for disallowed HTTP(S) requests. Omit the remote notification icon in enterprise mode and use the packaged icon in ordinary mode.

In main `ipc.ts`, inject `openExternalURL(url)` as a dependency. In `index.ts`, implement it with the same policy before calling `shell.openExternal`. This main-process check remains mandatory even though the renderer checks first.

In `main/windows.ts`, add `session.webRequest.onBeforeRequest` after window construction. Cancel every request for which `enterpriseRendererRequestAllowed(ENTERPRISE_PROFILE, details.url)` is false, and log only `{ origin, resourceType }`, never the full URL query or headers. Also deny `setWindowOpenHandler` requests in enterprise mode and prevent `will-navigate` away from the trusted renderer URL. This boundary covers Markdown images, CSS/font assets, raw browser fetches, and future renderer code that does not use `platform.fetch`.

- [ ] **Step 4: Disable public release highlights**

Export:

```ts
export function shouldLoadReleaseHighlights(enterprise: boolean) {
  return !enterprise
}
```

In `HighlightsProvider`, mark the current version seen and return before selecting a fetcher when `platform.enterprise` is present.

- [ ] **Step 5: Run traffic-policy tests and typechecks**

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts src/main/index.test.ts
bun typecheck
```

Run from `packages/app`:

```bash
bun test src/context/highlights.test.ts src/desktop-menu.test.ts
bun typecheck
```

Expected: tests PASS and both typechecks exit 0.

- [ ] **Step 6: Commit renderer network policy**

```bash
git add packages/desktop/src/enterprise.ts packages/desktop/src/enterprise.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/main/windows.ts packages/desktop/src/renderer/index.tsx packages/app/src/context/highlights.tsx packages/app/src/context/highlights.test.ts
git commit -m "feat(desktop): block public renderer traffic"
```

### Task 5: Verify the guidance harness as one deliverable

**Files:**
- Verify only; no source changes expected.

**Interfaces:**
- Confirms guide loading, prompt selection, permissions, local help, and URL policy.

- [ ] **Step 1: Run focused package tests**

Run from `packages/opencode`:

```bash
bun test test/session/system.test.ts test/config/config.test.ts test/permission/next.test.ts
```

Run from `packages/app`:

```bash
bun test src/desktop-menu.test.ts src/context/highlights.test.ts
```

Run from `packages/desktop`:

```bash
bun test src/enterprise.test.ts src/main/index.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run changed-package typechecks**

Run `bun typecheck` separately from `packages/opencode`, `packages/app`, and `packages/desktop`.

Expected: all three commands exit 0.

- [ ] **Step 3: Audit reachable public URLs**

```bash
rg -n "opencode\.ai|opncd\.ai|models\.dev|github\.com/anomalyco|discord\.com" packages/desktop/src packages/app/src packages/opencode/src/session packages/opencode/src/config packages/opencode/src/share
```

Expected: remaining URLs are confined to ordinary-build menu/copy branches, schemas, tests, disabled share defaults, and non-enterprise prompts. Every runtime branch reachable in enterprise mode is covered by an enterprise gate or main-process URL policy.

- [ ] **Step 4: Record the guidance checkpoint**

```bash
git status --short
git log -4 --oneline
```

Expected: no uncommitted source changes and the four task commits are visible.
