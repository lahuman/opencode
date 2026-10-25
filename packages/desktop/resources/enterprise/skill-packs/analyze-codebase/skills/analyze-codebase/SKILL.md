---
name: analyze-codebase
description: 기존 코드의 구조와 동작 흐름을 이해하거나 변경 대상과 영향 범위를 파악해야 할 때 사용합니다.
---

# Analyze Codebase

이 스킬을 사용할 때 사용자에게 전달하는 설명과 최종 응답은 한국어로 작성합니다.

Build an evidence-based map of the relevant code before explaining behavior, recommending changes, or making changes. Distinguish observed behavior, reasonable inference, and missing information.

## Plan and Build

- A skill does not change the active mode or grant permission to implement. In Plan, use available read-only tools such as read, glob, grep, and git_diff; do not run shell commands or modify files.
- Complete analysis, explanation, and planning-only requests with findings in the conversation. Build approval is not a prerequisite for reading or understanding code, even when a preferred tool is unavailable.
- While in Plan, if the user explicitly requests implementation or command execution, finish the available analysis and use plan_exit to present the proposed work for approval. Only the approval form's Build now choice switches modes; do not tell the user to type it in chat. If they keep planning or dismiss the form, stay in Plan without repeating approval for the same request.

## Analysis workflow

1. Read the nearest project instructions, package manifest, and configuration files.
2. Locate entry points with repository search, then trace calls and data flow to their consumers.
3. Inspect tests, types, schemas, generated boundaries, and configuration that constrain the behavior.
4. Check recent local history when it explains why the code has its current shape.
5. When a change is requested, identify the smallest change surface and the downstream behavior it can affect.

Prefer symbol and text search before broad directory reading. Read complete functions and nearby types instead of reasoning from isolated matching lines.

## Evidence rules

- Cite local file paths for important conclusions.
- Treat code as evidence of current behavior, not intended behavior.
- Label uncertain conclusions as inference and state what would confirm them.
- Do not invent requirements, hidden services, or unavailable documentation.
- Do not modify files when the request is analysis-only.

## Analysis output

Report:

- Current behavior and its entry point
- Relevant control flow and data flow
- Relevant files and tests; when a change is requested, identify which are likely to change
- Compatibility, state, security, or migration risks
- Open questions that materially affect the requested analysis or implementation

Keep the report scoped to the requested behavior. Exclude unrelated architecture observations unless they create a concrete risk.

When review or implementation follows, carry forward the relevant file paths, findings, and open questions. Do not repeat completed analysis merely because another skill is selected. Diagnosis can use debug-problems; review and completion checks can use verify-changes when the user requests them.
