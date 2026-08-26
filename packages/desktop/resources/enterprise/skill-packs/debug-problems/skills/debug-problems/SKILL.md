---
name: debug-problems
description: 버그, 테스트 실패, 빌드 오류 또는 예상치 못한 동작의 근본 원인을 조사해야 할 때 사용합니다.
---

# Debug Problems

이 스킬을 사용할 때 사용자에게 전달하는 설명과 최종 응답은 한국어로 작성합니다.

Find the root cause before proposing a fix. A plausible edit is not evidence that the problem is understood.

## 1. Reproduce

- Reproduce only in a safe local or test environment. Do not mutate production data, external systems, or user state without explicit authorization.
- Run the smallest documented command that demonstrates the failure from the owning package.
- Capture the exact error, inputs, environment assumptions, and whether the failure is deterministic.
- Read the complete failing path, nearby tests, and relevant recent changes.
- If reproduction is impossible, identify the missing condition instead of guessing.

## 2. Trace the cause

- Trace incorrect values and state backward from the failure to where they were introduced.
- Inspect boundaries such as parsing, configuration, persistence, concurrency, process startup, and external adapters.
- Compare with a working path or earlier state and list concrete differences.
- Separate the triggering condition from the underlying defect.

## 3. Test one hypothesis

State one falsifiable explanation: "The failure occurs because X, as shown by Y." Run the smallest experiment that can disprove it. Change one variable at a time.

If three distinct hypotheses or experiments fail, stop and reconsider the architecture, assumptions, and reproduction evidence before proposing another fix.

## 4. Fix and verify

When implementation is requested:

1. Add the smallest test that reproduces the defect and confirm it fails for the expected reason.
2. Apply the minimal root-cause fix without unrelated cleanup.
3. Run the reproducing test, then the affected package's broader checks.
4. Inspect the final diff for accidental behavior changes.

Report the root cause, supporting evidence, applied fix, and verification results separately.
