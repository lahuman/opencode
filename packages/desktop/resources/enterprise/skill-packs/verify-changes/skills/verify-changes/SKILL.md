---
name: verify-changes
description: 변경사항을 리뷰하거나 작업 완료·커밋·PR 전에 요구사항과 검증 결과를 확인할 때 사용합니다.
---

# Verify Changes

이 스킬을 사용할 때 사용자에게 전달하는 설명과 최종 응답은 한국어로 작성합니다.

Review the exact change set for actionable defects and base completion claims on fresh verification evidence. Confidence, earlier output, and code inspection do not replace execution evidence.

## Plan and Build

- A skill does not change the active mode or grant permission to implement. In Plan, inspect the requested diff, requirements, tests, and existing results using read-only tools. Do not run shell commands or modify files, including to run tests or build artifacts.
- Report static findings and checks still requiring execution separately. Complete this read-only report without Build approval, and do not claim that tests passed or the work is ready when execution was unavailable.
- While in Plan, if the user requests running checks or implementing fixes, finish the available inspection and call plan_exit with the proposed commands and work. Only the approval form's Build now choice switches modes; do not ask the user to type it in chat. If they decline or dismiss it, stay in Plan without repeating approval for the same request.
- A review request alone does not authorize fixes, even in Build. A request for verification in Build authorizes relevant checks, not automatic fixes, commits, pushes, or deployment. Perform those actions only when requested. Reuse earlier analysis and diagnosis findings, but obtain fresh execution evidence for the final changes.

## Code review

1. Establish the requested comparison range: working tree, staged changes, or branch against its base. A clean working tree can still contain committed changes to review.
2. Read the changed code together with its callers, types, and tests. Prioritize concrete correctness defects, regressions, and missing coverage of changed behavior over unrelated style preferences.
3. For each actionable finding, give its severity, file and line, triggering condition, observable impact, and supporting evidence. Separate confirmed defects from hypotheses that need execution to verify.
4. Present findings first, ordered by impact. If none are found, say so and report the scope and unverified behavior; do not invent findings or claim that all behavior is correct.

For review-only requests, finish with the findings and evidence limits. For completion or execution requests, continue with the checks below as the active mode permits. Use debug-problems for root-cause investigation when a failure needs deeper diagnosis; do not automatically expand a review into implementation.

## Verification workflow

1. Restate the requested outcomes as checkable conditions.
2. Identify the intended comparison range (working tree, staged changes, or branch against its base), inspect that diff, and identify every affected package or runtime boundary.
3. Read project instructions to select the authoritative test, type-check, lint, and build commands.
4. In Build, run the narrowest relevant checks first, followed by broader checks proportional to the change risk. In Plan, identify those checks and mark them as not run.
5. Read the complete command output and confirm the intended checks actually ran, including the exit status, result count, failures, and skipped checks.
6. Compare the same final change set with the requested scope and check for unintended files or generated artifacts.

Run commands from the package directory required by the project. Do not substitute an easier command for the documented one without saying so.

## Completion contract

Before stating that work is complete, fixed, passing, or ready:

- Every required outcome has direct evidence.
- Relevant tests and static checks have fresh successful output.
- Failures and warnings are investigated, not hidden.
- Unavailable checks are reported as unverified with the exact blocker.
- The summary distinguishes verified facts from remaining risk.

Use this report shape:

```text
Verified: <requirement or behavior> — <command or inspection evidence>
Not verified: <check> — <reason and impact>
Remaining risk: <specific risk or none identified>
```

If a required check fails, report the failure. Do not describe the work as complete.
