# Focused Development Skill Packs Design

## Purpose

Replace the broad enterprise skill collection with three default-enabled skills whose names state exactly when developers should invoke them. The skills must remain useful without company policy documents, approved-library catalogs, internal package mirrors, or public internet access.

## Skills

### Codebase Analysis

`analyze-codebase` maps existing behavior, control flow, data flow, tests, and change impact from local repository evidence. It separates observed facts from inference and does not modify files for analysis-only requests.

### Problem Debugging

`debug-problems` handles bugs, test failures, build errors, and unexpected behavior. It requires reproduction, root-cause tracing, one hypothesis at a time, a failing regression test when implementation is requested, and focused verification after the fix.

### Change Verification

`verify-changes` checks requirements against the current diff and fresh command output. It runs the project-defined tests, type checks, lint, and builds in proportion to risk and reports unavailable checks as unverified instead of claiming completion.

## Packaging

Each skill is packaged independently under an ID matching its slash command. Display names remain concise English labels, while catalog descriptions, skill trigger descriptions, and short UI descriptions are Korean. All three packs use version `1.0.0`, the repository MIT license, and deterministic SHA-256 tree hashes.

The previous company-context, offline-dependency, and five-skill quality-gate packs are removed. The portable verifier requires the license for each new pack and verifies every cataloged tree.

## Verification

- Catalog tests assert exactly three pack IDs and one matching member per pack.
- Metadata tests assert English display names and Korean descriptions.
- Static tests reject public URLs, acquisition commands, and stale Superpowers references in bundled skill Markdown.
- Package fixtures and portable smoke checks require the three new pack licenses.
- Desktop and app tests and type checks remain green.
