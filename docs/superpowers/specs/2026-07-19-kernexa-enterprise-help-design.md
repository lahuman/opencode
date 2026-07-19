# Kernexa Enterprise Help Design

## Decision Summary

The enterprise desktop edition will replace the generic English Tabs promotion with Korean Kernexa onboarding content. Public OpenCode editions retain the existing Tabs promotion unchanged.

The enterprise help guide will use the Kernexa brand consistently:

- Help label and command: `Kernexa AI 가이드`
- Dialog title: `Kernexa AI 가이드`
- Version label: `버전 kernexa-1`
- Guide version identifier: `kernexa-1`

## Scope

This change applies only when the desktop platform exposes the enterprise profile. It covers:

- The temporary Tabs information card and its detail drawer
- Help button accessibility labels
- The enterprise desktop Help menu
- The enterprise guide command and dialog
- Enterprise error-page recovery actions
- The bundled enterprise guide heading
- Active enterprise configuration, manifest, release runbook, tests, and fixtures that declare the guide version

Ordinary OpenCode web and desktop editions continue to show the existing English `Introducing Tabs` experience and OpenCode help links.

## Enterprise Onboarding Copy

### Compact card

- Accessible label: `Kernexa 시작 안내. 코드 분석부터 검증까지 AI 코딩 작업 흐름을 확인합니다.`
- Dismiss label: `Kernexa 시작 안내 닫기`
- Title: `Kernexa 시작하기`
- Description: `코드 분석부터 구현과 검증까지 한곳에서 진행하세요.`

The compact card keeps the existing size and positioning. It reuses a bundled local product image instead of relying on a network resource. The public edition continues to use the existing Tabs video.

### Detail drawer

- Header: `시작 안내`
- Close label: `닫기`
- Title: `Kernexa AI Coding Workspace`

The drawer explains the three product pillars in Korean:

1. **분석**: 저장소 구조와 기존 코드를 근거로 변경 범위와 영향을 이해합니다.
2. **구현**: 필요한 변경에 집중하고 문제 원인을 체계적으로 해결합니다.
3. **검증**: 테스트, 타입 검사, 빌드와 변경 내역을 확인한 뒤 결과를 마무리합니다.

It also explains that Kernexa is designed for controlled closed-network environments, uses only configured internal AI services, and provides the detailed operating policy through `Kernexa AI 가이드` in the Help menu.

Existing bundled Home and Tabs screenshots may be reused where they support the explanation. No new image or video asset is required for this change.

## Guide Branding and Version

Every active enterprise surface that currently presents `Company AI Guide` will present `Kernexa AI 가이드`, including:

- Floating help button accessible name
- Command palette entry
- Windows and native desktop Help menu
- Guide dialog title and content-region accessible name
- Error-page recovery button
- Enterprise browser tests and desktop menu tests

The dialog will render `버전 {guide.version}`. Active enterprise configurations change the guide version identifier from `pilot-1` to `kernexa-1`. Other version identifiers such as defaults or catalog versions are not renamed unless they describe the guide itself.

The bundled Markdown guide heading will be `Kernexa AI 사용 가이드`. Its policy body remains substantively unchanged. Because the guide resource and version change, the enterprise manifest must be regenerated so its guide hash and `guideVersion` remain internally consistent.

## Component Design

### `TabsInfoPopup`

`TabsInfoPopup` will branch its visible and accessible copy on `platform.enterprise`:

- Enterprise branch: Korean Kernexa onboarding content and local static imagery
- Public branch: existing English Tabs card, video, and drawer content

The existing dismissal state, drawer state, focus behavior, layout, and persistence contract remain unchanged.

### Enterprise guide UI

The existing command ID `company.guide.open` and IPC contracts remain unchanged to avoid unnecessary compatibility changes. Only user-facing labels, accessible names, and the guide version data change.

### Configuration and manifest

All active enterprise build examples and executable fixtures will use `OPENCODE_ENTERPRISE_GUIDE_VERSION=kernexa-1`. The checked-in enterprise manifest will be regenerated from the updated guide resource and version. Historical dated specifications and plans remain historical and are not rewritten.

## Error Handling and Offline Behavior

No new network access is introduced. The onboarding content and media are bundled application assets. Existing behavior for a failed guide read remains unchanged: the application reports the existing guide-load failure and restores focus safely.

## Testing

Tests will verify:

- Enterprise onboarding source contains the approved Korean Kernexa copy.
- Public onboarding retains `Introducing Tabs` and its existing English content.
- Enterprise help menu, command, dialog, error action, and accessibility labels use `Kernexa AI 가이드`.
- The dialog renders the Korean version label and the `kernexa-1` guide version.
- Active enterprise configuration and generated manifest agree on `kernexa-1`.
- The regenerated manifest validates the updated guide resource hash.
- Ordinary OpenCode help behavior remains unchanged.

Type checking will run from `packages/app` and `packages/desktop`. Relevant unit and enterprise browser tests will run from their package directories.

## Acceptance Criteria

- Kernexa users no longer see English `Introducing Tabs` text in the temporary onboarding card or drawer.
- The enterprise onboarding content is entirely Korean apart from the product descriptor `AI Coding Workspace` and intentional command/skill identifiers.
- Public OpenCode still receives the original Tabs onboarding experience.
- No active enterprise UI displays `Company AI Guide`, `Version`, or the guide version `pilot-1`.
- Active enterprise UI displays `Kernexa AI 가이드` and `버전 kernexa-1`.
- The bundled guide, manifest, and build configuration use the same guide version and resource hash.
- No external asset or internet dependency is added.

