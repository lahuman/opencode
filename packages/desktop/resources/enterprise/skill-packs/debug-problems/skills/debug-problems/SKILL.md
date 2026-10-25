---
name: debug-problems
description: 버그, 테스트 실패, 빌드 오류 또는 예상치 못한 동작의 근본 원인을 조사해야 할 때 사용합니다.
---

# Debug Problems

이 스킬을 사용할 때 사용자에게 전달하는 설명과 최종 응답은 한국어로 작성합니다.

Find the root cause before proposing a fix. A plausible edit is not evidence that the problem is understood. Reuse relevant code maps and evidence already produced with analyze-codebase.

## Plan and Build

- A skill does not change the active mode or grant permission to implement. In Plan, inspect code, diffs, tests, and available logs using read-only tools. Do not run shell commands, including reproduction or test commands, or modify files.
- Finish diagnosis-only requests with findings and any limits of the evidence. Do not require Build approval to start or complete the available read-only work.
- While in Plan, if the user explicitly requests fixes or command execution, finish the available investigation and use plan_exit to present the proposed work for approval. Only the approval form's Build now choice switches modes; typing it in chat does not approve implementation. If approval is declined or dismissed, remain in Plan without repeating approval for the same request.

## 1. Reproduce

- Reproduce only in a safe local or test environment. Do not mutate production data, external systems, or user state without explicit authorization.
- When reproduction is within the requested scope and Build is active, run the smallest documented command that demonstrates the failure from the owning package. In Plan, inspect the existing error and code path, and report the reproduction command as not run.
- Capture the exact error, inputs, environment assumptions, and whether the failure is deterministic.
- Read the complete failing path, nearby tests, and relevant recent changes.
- If reproduction is impossible, identify the missing condition instead of guessing.

## 2. Trace the cause

- Trace incorrect values and state backward from the failure to where they were introduced.
- Inspect boundaries such as parsing, configuration, persistence, concurrency, process startup, and external adapters.
- Compare with a working path or earlier state and list concrete differences.
- Separate the triggering condition from the underlying defect.

## 3. Test one hypothesis

State one falsifiable explanation: "The failure occurs because X, as shown by Y." Use available read-only evidence to test it; run an experiment only when it is within the requested scope and the active mode permits execution. Change one variable at a time.

If three distinct hypotheses or experiments fail, stop and reconsider the architecture, assumptions, and reproduction evidence before proposing another fix.

## 4. Fix and verify

When implementation is requested and Build is active:

1. Add the smallest test that reproduces the defect and confirm it fails for the expected reason.
2. Apply the minimal root-cause fix without unrelated cleanup.
3. Run the reproducing test, then the affected package's broader checks.
4. Inspect the final diff for accidental behavior changes.

Report the root cause, supporting evidence, applied fix, and verification results separately.

Use verify-changes to review the resulting diff and confirm completion when requested. Carry forward the reproduction evidence and changed behavior instead of restarting the investigation.
