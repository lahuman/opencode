# Kernexa Enterprise Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the enterprise-only Tabs promotion with Korean Kernexa onboarding and rename/version every active enterprise guide surface as `Kernexa AI 가이드` with `버전 kernexa-1`.

**Architecture:** Keep public OpenCode rendering unchanged and branch only on the existing `platform.enterprise` capability. Store the approved enterprise onboarding copy in a small data-only module so it can be tested without rendering media assets. Preserve existing command IDs and IPC contracts, then refresh the ignored build-generated enterprise manifest from the updated guide and version while preserving its configured model-catalog identity.

**Tech Stack:** TypeScript, SolidJS, Bun test runner, Playwright, Electron enterprise resources, Markdown, JSON.

## Global Constraints

- Enterprise compact-card title is exactly `Kernexa 시작하기`.
- Enterprise compact-card description is exactly `코드 분석부터 구현과 검증까지 한곳에서 진행하세요.`.
- Enterprise drawer title is exactly `Kernexa AI Coding Workspace`.
- Enterprise guide name is exactly `Kernexa AI 가이드`.
- Enterprise guide version identifier is exactly `kernexa-1`, rendered as `버전 kernexa-1`.
- Public OpenCode retains the existing English `Introducing Tabs` card, video, drawer, and help-link behavior.
- All enterprise onboarding media remains bundled locally; no network resource or dependency is added.
- The command ID remains `company.guide.open` and existing IPC shapes remain unchanged.
- `defaultsVersion` and `catalogVersion` are not renamed as part of the guide-version change.
- Historical dated plans and specifications are not rewritten.
- Tests and type checks run from their package directories, never from the repository root.

---

### Task 1: Kernexa guide labels across active UI surfaces

**Files:**

- Modify: `packages/app/src/components/dialog-company-guide.test.ts`
- Modify: `packages/app/src/desktop-menu.test.ts`
- Modify: `packages/app/e2e/company-llm-enterprise.spec.ts`
- Modify: `packages/app/src/components/dialog-company-guide.tsx`
- Modify: `packages/app/src/components/help-button.tsx`
- Modify: `packages/app/src/desktop-menu.ts`
- Modify: `packages/app/src/pages/error.tsx`

**Interfaces:**

- Consumes: existing `company.guide.open` command and `Platform.enterprise.readGuide()` result `{ version: string; markdown: string }`.
- Produces: user-facing guide label `Kernexa AI 가이드` and dialog version prefix `버전` without changing command or IPC identifiers.

- [ ] **Step 1: Write failing unit and browser expectations**

In `dialog-company-guide.test.ts`, assert the command title:

```ts
expect(command?.id).toBe("company.guide.open")
expect(command?.title).toBe("Kernexa AI 가이드")
```

In `desktop-menu.test.ts`, change the enterprise help expectation to:

```ts
expect(help?.items?.filter((item) => item.type === "item").map((item) => item.label)).toEqual([
  "Kernexa AI 가이드",
  "Export Logs...",
])
```

In `company-llm-enterprise.spec.ts`, replace active guide selectors and assertions with:

```ts
page.getByRole("menuitem", { name: "Kernexa AI 가이드" })
page.getByRole("button", { name: "Kernexa AI 가이드 열기" })
dialog.getByRole("region", { name: "Kernexa AI 가이드 내용" })
dialog.getByText("Kernexa AI 가이드", { exact: true })
dialog.getByText("버전 kernexa-1", { exact: true })
```

- [ ] **Step 2: Run focused tests and confirm the old labels fail**

From `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/dialog-company-guide.test.ts ./src/desktop-menu.test.ts
```

Expected: failures show `Company AI Guide` instead of `Kernexa AI 가이드`.

- [ ] **Step 3: Implement the guide labels**

Use these exact values in `dialog-company-guide.tsx`:

```tsx
title: "Kernexa AI 가이드"
```

```tsx
<span class="text-16-medium text-text-strong">Kernexa AI 가이드</span>
<span class="max-w-full break-words text-11-regular text-text-weak">버전 {props.version}</span>
```

```tsx
aria-label="Kernexa AI 가이드 내용"
```

Use `Kernexa AI 가이드` in the enterprise desktop menu. Use `Kernexa AI 가이드 열기` for the floating help button and error-page accessible names, while visible error-page text is `Kernexa AI 가이드`.

- [ ] **Step 4: Re-run focused unit tests**

Run the command from Step 2. Expected: pass.

- [ ] **Step 5: Commit the guide-label unit**

```powershell
git add packages/app/src/components/dialog-company-guide.tsx packages/app/src/components/dialog-company-guide.test.ts packages/app/src/components/help-button.tsx packages/app/src/desktop-menu.ts packages/app/src/desktop-menu.test.ts packages/app/src/pages/error.tsx packages/app/e2e/company-llm-enterprise.spec.ts
git commit -m "feat(app): brand Kernexa help guide"
```

### Task 2: Enterprise-only Korean onboarding content

**Files:**

- Create: `packages/app/src/components/help-content.ts`
- Create: `packages/app/src/components/help-content.test.ts`
- Modify: `packages/app/src/components/help-button.tsx`

**Interfaces:**

- Produces: `KERNEXA_ONBOARDING`, a readonly data object consumed by `TabsInfoPopup`.
- Consumes: existing `platform.enterprise`, `settings.general.shouldDisplayTabsToast()`, local `homeImage`, `tabsImage`, and the public Tabs video.

- [ ] **Step 1: Write the failing content-contract test**

Create `help-content.test.ts`:

```ts
import { expect, test } from "bun:test"
import { KERNEXA_ONBOARDING } from "./help-content"

test("defines the approved Korean Kernexa onboarding copy", () => {
  expect(KERNEXA_ONBOARDING.card).toEqual({
    ariaLabel: "Kernexa 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "Kernexa 시작 안내 닫기",
    title: "Kernexa 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  })
  expect(KERNEXA_ONBOARDING.drawer).toMatchObject({
    header: "시작 안내",
    closeLabel: "닫기",
    title: "Kernexa AI Coding Workspace",
  })
  expect(KERNEXA_ONBOARDING.drawer.sections.map((section) => section.title)).toEqual(["분석", "구현", "검증"])
  expect(KERNEXA_ONBOARDING.drawer.offline).toContain("폐쇄망")
  expect(KERNEXA_ONBOARDING.drawer.guide).toContain("Kernexa AI 가이드")
})
```

- [ ] **Step 2: Run the new test and confirm the module is missing**

From `packages/app`:

```powershell
bun.cmd test ./src/components/help-content.test.ts
```

Expected: fail because `./help-content` does not exist.

- [ ] **Step 3: Create the data-only content module**

Create `help-content.ts`:

```ts
export const KERNEXA_ONBOARDING = {
  card: {
    ariaLabel: "Kernexa 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.",
    dismissLabel: "Kernexa 시작 안내 닫기",
    title: "Kernexa 시작하기",
    description: "코드 분석부터 구현과 검증까지 한곳에서 진행하세요.",
  },
  drawer: {
    header: "시작 안내",
    closeLabel: "닫기",
    title: "Kernexa AI Coding Workspace",
    intro: "Kernexa는 저장소의 맥락을 이해하고 필요한 변경을 구현한 뒤 결과를 근거로 검증하는 AI 코딩 작업공간입니다.",
    sections: [
      { title: "분석", description: "저장소 구조와 기존 코드를 근거로 변경 범위와 영향을 이해합니다." },
      { title: "구현", description: "필요한 변경에 집중하고 문제 원인을 체계적으로 해결합니다." },
      { title: "검증", description: "테스트, 타입 검사, 빌드와 변경 내역을 확인한 뒤 결과를 마무리합니다." },
    ],
    offline: "Kernexa는 통제된 폐쇄망 환경을 위해 설계되며, 설정된 내부 AI 서비스만 사용합니다.",
    guide: "자세한 운영 기준은 도움말 메뉴의 Kernexa AI 가이드에서 확인할 수 있습니다.",
  },
} as const
```

- [ ] **Step 4: Render enterprise content without changing the public branch**

In `help-button.tsx`, import `KERNEXA_ONBOARDING`. Branch the compact card labels, text, and media on `platform.enterprise`. The enterprise media is:

```tsx
<img src={homeImage} alt="" class="absolute inset-0 h-full w-full object-cover" />
```

The public fallback remains the existing `introducingTabsVideo` element and exact English strings. In the drawer, render `KERNEXA_ONBOARDING.drawer` for enterprise and retain the existing English paragraphs/images as the fallback. Map the three enterprise sections with visible Korean headings and descriptions.

- [ ] **Step 5: Run the content and existing help tests**

From `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/help-content.test.ts ./src/components/dialog-company-guide.test.ts ./src/desktop-menu.test.ts
```

Expected: all pass.

- [ ] **Step 6: Confirm public copy remains in source**

From the repository root:

```powershell
rg -n "Introducing Tabs|Organize your work and active sessions with tabs" packages/app/src/components/help-button.tsx
```

Expected: both original public strings remain.

- [ ] **Step 7: Commit the onboarding unit**

```powershell
git add packages/app/src/components/help-content.ts packages/app/src/components/help-content.test.ts packages/app/src/components/help-button.tsx
git commit -m "feat(app): add Korean Kernexa onboarding"
```

### Task 3: Guide resource and `kernexa-1` version contract

**Files:**

- Modify: `packages/desktop/resources/enterprise/company-guide.md`
- Refresh: ignored build output `packages/desktop/resources/enterprise/enterprise-manifest.json`
- Modify: `docs/enterprise/windows-portable-kernexa-release.md`
- Modify: `packages/app/e2e/fixtures/company-llm-enterprise.tsx`
- Modify: `packages/app/test-browser/fixtures/highlights-provider-entrypoint.ts`
- Modify: `packages/desktop/test/windows-policy-entrypoint.ts`
- Modify: `packages/desktop/test/renderer-platform-entrypoint.ts`
- Modify: `packages/desktop/test/renderer-index-entrypoint.tsx`
- Modify: `packages/desktop/test/main-index-entrypoint.ts`
- Modify: `packages/desktop/test/ipc-entrypoint.ts`
- Modify: `packages/desktop/src/enterprise.test.ts`
- Modify: `packages/desktop/scripts/verify-enterprise-package.test.ts`
- Modify: `packages/desktop/scripts/package-enterprise-win.test.ts`
- Modify: `packages/desktop/scripts/enterprise-release.test.ts`
- Modify: `packages/desktop/scripts/enterprise-build.test.ts`
- Modify: `packages/desktop/electron.vite.config.test.ts`
- Modify: `packages/desktop/electron-builder.config.test.ts`

**Interfaces:**

- Consumes: `OPENCODE_ENTERPRISE_GUIDE_VERSION` and manifest resource hashing.
- Produces: guide version `kernexa-1` consistently across runtime fixtures, release examples, the checked-in manifest, and the UI guide payload.

- [ ] **Step 1: Change guide-specific expectations to `kernexa-1`**

Change only `OPENCODE_ENTERPRISE_GUIDE_VERSION`, `guideVersion`, and `readGuide().version` values that currently use `pilot-1` or `2026.07`. Do not change `OPENCODE_ENTERPRISE_DEFAULTS_VERSION` or `catalogVersion` values.

In `company-llm-enterprise.spec.ts`, expect:

```ts
await expect(dialog.getByText("버전 kernexa-1", { exact: true })).toBeVisible()
```

In the fixture, return:

```ts
return { version: "kernexa-1", markdown: GUIDE_MARKDOWN }
```

- [ ] **Step 2: Run focused version tests and confirm failures**

From `packages/desktop`:

```powershell
bun.cmd test src/enterprise.test.ts scripts/enterprise-build.test.ts electron.vite.config.test.ts
```

Expected: failures show `pilot-1` where the updated expectations require `kernexa-1`.

- [ ] **Step 3: Rename the bundled guide heading and active runbook version**

Change the first guide line to:

```markdown
# Kernexa AI 사용 가이드
```

In `docs/enterprise/windows-portable-kernexa-release.md`, set:

```powershell
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION = "kernexa-1"
```

Keep the active defaults and catalog version values unchanged.

- [ ] **Step 4: Regenerate the enterprise manifest**

From `packages/desktop`, set the non-secret values represented by the current checked-in catalog and run:

```powershell
$env:OPENCODE_ENTERPRISE='1'
$env:OPENCODE_ENTERPRISE_MODELS='[{"id":"qwen/qwen3.5-122b-a10b","name":"Qwen 3.5 122B A10B","baseURL":"https://integrate.api.nvidia.com/v1"},{"id":"tencent/hy3:free","name":"Tencent HY3","baseURL":"https://openrouter.ai/api/v1"}]'
$env:OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID='tencent/hy3:free'
$env:OPENCODE_ENTERPRISE_DEFAULTS_VERSION='nvidia-test-1'
$env:OPENCODE_ENTERPRISE_GUIDE_VERSION='kernexa-1'
$env:OPENCODE_ENTERPRISE_CATALOG_VERSION='dev-1'
$env:OPENCODE_ENTERPRISE_ALLOWED_ORIGINS='https://integrate.api.nvidia.com,https://openrouter.ai'
bun.cmd run generate:enterprise:manifest
```

Expected: `resources/enterprise/enterprise-manifest.json` contains `"guideVersion": "kernexa-1"` and a new SHA-256 for `company-guide.md`. Preserve the pre-existing `modelCatalogSHA256`, model IDs, defaults version, catalog version, default model, and allowed origins if the local build profile is not reproducible from repository sources.

- [ ] **Step 5: Run desktop version and manifest tests**

From `packages/desktop`:

```powershell
bun.cmd test src/enterprise.test.ts scripts/enterprise-build.test.ts scripts/enterprise-manifest.test.ts scripts/verify-enterprise-package.test.ts scripts/package-enterprise-win.test.ts scripts/enterprise-release.test.ts electron.vite.config.test.ts electron-builder.config.test.ts
```

Expected: guide-version and manifest assertions pass. Record separately any pre-existing Windows path or symlink-permission failures.

- [ ] **Step 6: Run the enterprise guide browser test**

From `packages/app`:

```powershell
bun.cmd run test:e2e -- company-llm-enterprise.spec.ts
```

Expected: enterprise guide selectors find `Kernexa AI 가이드`, `Kernexa AI 가이드 내용`, and `버전 kernexa-1`; public help assertions remain unchanged.

- [ ] **Step 7: Commit the version and resource unit**

Stage only the files listed in Task 3 and commit:

```powershell
git commit -m "chore(desktop): version Kernexa guide"
```

### Task 4: Cross-package verification

**Files:**

- Verify: `packages/app`
- Verify: `packages/desktop`
- Verify: `docs/enterprise/windows-portable-kernexa-release.md`

**Interfaces:**

- Consumes: all outputs from Tasks 1-3.
- Produces: evidence that enterprise branding changed without altering public OpenCode behavior or offline controls.

- [ ] **Step 1: Scan active UI for retired guide labels and versions**

From the repository root:

```powershell
rg -n "Company AI Guide|Version pilot-1|OPENCODE_ENTERPRISE_GUIDE_VERSION.*pilot-1|guideVersion.*pilot-1" packages/app packages/desktop docs/enterprise
```

Expected: no active matches. Historical `docs/superpowers` files are intentionally excluded.

- [ ] **Step 2: Verify both enterprise and public onboarding branches remain**

```powershell
rg -n "Kernexa 시작하기|Kernexa AI Coding Workspace|Introducing Tabs|introducingTabsVideo" packages/app/src/components/help-button.tsx packages/app/src/components/help-content.ts
```

Expected: Kernexa and public Tabs content are both present.

- [ ] **Step 3: Run app unit tests and type checks**

From `packages/app`:

```powershell
bun.cmd test --preload ./happydom.ts ./src/components/help-content.test.ts ./src/components/dialog-company-guide.test.ts ./src/desktop-menu.test.ts
bun.cmd typecheck
bun.cmd run typecheck:e2e
```

Expected: all commands exit 0.

- [ ] **Step 4: Run desktop type checking and focused tests**

From `packages/desktop`:

```powershell
bun.cmd typecheck
bun.cmd test src/enterprise.test.ts scripts/enterprise-build.test.ts scripts/enterprise-manifest.test.ts scripts/verify-enterprise-package.test.ts scripts/package-enterprise-win.test.ts scripts/enterprise-release.test.ts electron.vite.config.test.ts electron-builder.config.test.ts
```

Expected: typecheck exits 0 and all product-related assertions pass. Any unchanged environment-only failures must match the recorded baseline exactly.

- [ ] **Step 5: Inspect final changes**

From the repository root:

```powershell
git diff --check
git diff -- packages/app packages/desktop/resources/enterprise docs/enterprise/windows-portable-kernexa-release.md
```

Confirm there are no new network resources, public help behavior remains, the guide command ID is unchanged, and the manifest hash matches the updated guide.
