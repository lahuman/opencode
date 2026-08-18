# SFMI Brand and Product Identity Design

## Decision Summary

The closed-network desktop application will be renamed **SFMI** and treated as a new, independent product rather than a continuation of Company OpenCode Pilot.

- Product name: `SFMI`
- Product descriptor: `AI Coding Workspace`
- Primary tagline: `Analyze. Build. Verify.`
- Positioning: an AI coding tool that improves developer productivity through codebase understanding, systematic problem solving, and evidence-based verification
- Data policy: start with a new application identity and a new user-data directory; do not migrate existing Pilot settings or credentials

## Name Meaning

`SFMI` is the canonical product name. This repository does not define or infer an expansion for the name. The rename changes product identity while preserving the existing product descriptor, positioning, and deployment policy.

## Pronunciation and Writing

- Canonical spelling: `SFMI`
- Do not use: `Sfmi`, `S.F.M.I.`, or `SFMI AI` as the primary product name
- Use the descriptor when context is needed: `SFMI — AI Coding Workspace`

The wordmark and product copy should keep all four letters uppercase. Do not invent an expansion for the name in product copy.

## Brand Positioning

SFMI is for developers who need an AI coding workspace that can understand an existing repository, investigate failures, make focused changes, and prove the result. Closed-network operation is an important deployment property, but it is not the headline brand promise.

### Product promise

> Turn codebase context into verified progress.

### Product pillars

1. **Analyze** — understand architecture, behavior, and change impact from repository evidence.
2. **Build** — help developers implement focused changes and resolve problems with clear reasoning.
3. **Verify** — validate outcomes with tests, type checks, builds, and diff inspection before completion claims.

These pillars align with the bundled `/analyze-codebase`, `/debug-problems`, and `/verify-changes` skills.

### Voice

SFMI should sound precise, calm, practical, and engineering-led. Avoid exaggerated claims such as autonomous replacement of developers, magical one-click delivery, or absolute guarantees. Prefer language centered on evidence, collaboration, and measurable progress.

## Product Identity

The implementation will use the following identity consistently:

| Surface | Value |
|---|---|
| Product name | `SFMI` |
| Window and document title | `SFMI` |
| Product descriptor | `AI Coding Workspace` |
| Application ID | `com.company.sfmi` |
| Windows executable | `SFMI.exe` |
| Release artifact | `sfmi-${version}-win-x64.zip` |
| Checksum | `sfmi-${version}-win-x64.zip.sha256` |
| Release metadata | `sfmi-${version}-win-x64.release.json` |
| SBOM | `sfmi-${version}-win-x64.sbom.cdx.json` |
| Third-party notices | `sfmi-${version}-win-x64.third-party-licenses.txt` |
| Windows user data | `%LOCALAPPDATA%\com.company.sfmi` |
| Supply-chain component | `sfmi` |

The enterprise build remains portable and does not register the ordinary OpenCode protocol. Existing allowed-network, manifest, archive-integrity, and release-verification controls remain unchanged apart from product identity values.

## Fresh-Application Policy

SFMI starts as a new application:

- Do not read, copy, migrate, or delete `%LOCALAPPDATA%\com.company.opencode.pilot`.
- Create and use `%LOCALAPPDATA%\com.company.sfmi` for settings, state, caches, and DPAPI-protected credentials.
- Users must configure SFMI and enter credentials independently.
- The old Pilot application and its data may coexist with SFMI.
- Removing SFMI must not remove the Pilot directory, and removing Pilot must not remove SFMI data.

This separation prevents accidental credential or configuration inheritance and makes rollback to the old Pilot application independent of SFMI.

## Implementation Scope

Rename the active product identity across:

- Electron Builder product name, app ID, executable, and artifact naming
- Main-process identity, AppUserModelID, user-data resolution, and error messages
- Renderer and window titles
- Portable package creation and archive verification
- Release metadata, checksums, SBOM component name, and third-party notice heading
- Windows portable smoke checks and acceptance paths
- Current operator runbooks and all executable tests and fixtures

Dated historical design and implementation plans remain historical records. The active enterprise release runbook must be updated to SFMI and must no longer instruct operators to use Pilot artifact or AppData paths.

## Visual Direction

The initial naming change does not require a new logo or icon. When visual identity work begins, prefer a clean engineering aesthetic that suggests connected structure and forward motion. Avoid padlocks, shields, robots, chat bubbles, and generic circuit-brain imagery because security and AI are product properties, not the entire identity.

## Name-Collision Note

A preliminary web search did not identify a prominent software product using the exact `SFMI` name. This is not trademark clearance. Formal trademark, corporate-name, domain, and internal legal review are required before public or commercial release.

## Acceptance Criteria

- Enterprise builds display `SFMI` in the application, window, executable, and release artifacts.
- The app identity is `com.company.sfmi` on development and packaged enterprise builds.
- SFMI writes runtime data only under the new identity path.
- Existing Pilot data remains untouched.
- Portable verification and smoke scripts require the SFMI executable and artifact schema.
- Release metadata, SBOM, notices, and operator documentation consistently use SFMI.
- Ordinary non-enterprise OpenCode builds retain their existing identities and behavior.
- Tests contain no active enterprise expectations for the former Pilot identity.
