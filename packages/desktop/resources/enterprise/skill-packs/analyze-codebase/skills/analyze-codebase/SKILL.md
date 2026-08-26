---
name: analyze-codebase
description: 기존 코드의 구조와 동작 흐름을 이해하거나 변경 대상과 영향 범위를 파악해야 할 때 사용합니다.
---

# Analyze Codebase

이 스킬을 사용할 때 사용자에게 전달하는 설명과 최종 응답은 한국어로 작성합니다.

Build an evidence-based map of the relevant code before explaining behavior, recommending changes, or making changes. Distinguish observed behavior, reasonable inference, and missing information.

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
