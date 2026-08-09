---
name: verify-changes
description: 작업 완료를 선언하거나 커밋·PR을 만들기 전, 변경사항이 요구사항을 충족하고 검증 명령을 통과하는지 확인할 때 사용합니다.
---

# Verify Changes

Base completion claims on fresh evidence from the exact change set being verified. Confidence, earlier output, and code inspection do not replace verification.

## Verification workflow

1. Restate the requested outcomes as checkable conditions.
2. Identify the intended comparison range (working tree, staged changes, or branch against its base), inspect that diff, and identify every affected package or runtime boundary.
3. Read project instructions to select the authoritative test, type-check, lint, and build commands.
4. Run the narrowest relevant checks first, followed by broader checks proportional to the change risk.
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
