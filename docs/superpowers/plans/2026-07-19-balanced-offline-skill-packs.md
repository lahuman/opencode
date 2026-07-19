# Focused Development Skill Packs Implementation Plan

**Goal:** Replace seven specialized skills with three default-enabled, directly callable development skills.

## Tasks

- [x] Change catalog tests to require `analyze-codebase`, `debug-problems`, and `verify-changes` and confirm the old catalog fails.
- [x] Add one self-contained pack for each skill with English display names and Korean descriptions.
- [x] Remove the company-context, offline-dependency, and quality-gate pack directories.
- [x] Update catalog generation, portable package requirements, smoke checks, and test fixtures.
- [x] Regenerate deterministic pack hashes without network access.
- [x] Validate all skill metadata and run desktop and app tests and type checks.
- [x] Review the final diff for stale skill names and unintended changes.
