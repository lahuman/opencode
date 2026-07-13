# Enterprise Offline Desktop Pilot Design

## 1. Purpose

This design defines a Windows pilot edition of the OpenCode desktop application for use in a closed corporate network. The pilot must install from one Windows installer, start without internet access, connect to an on-premises OpenAI Compatible API, and apply company-provided AI guidance and default safety controls.

The pilot is an enterprise overlay on the existing desktop architecture. It preserves the Electron renderer and local sidecar, reuses the existing OpenAI Compatible provider, and disables known OpenCode cloud and public-internet integrations. This keeps the change maintainable against upstream OpenCode while providing a clearly separated corporate build profile.

## 2. Pilot Scope

### In scope

- Windows 10 and Windows 11 x64
- A single NSIS installer for a per-user pilot installation
- Offline startup and normal project use
- A preconfigured `Company LLM` provider backed by an OpenAI Compatible API
- Company defaults that users can adjust per project
- Bundled company AI guidance and default permission rules
- Removal or disabling of known OpenCode cloud and public-network paths
- Connection diagnostics and actionable error reporting
- Unit, integration, packaging, and offline network verification

### Out of scope

- SCCM, Intune, or software-center integration
- An internal automatic update service
- A central guide, model, or policy management server
- Organization-wide immutable policy administration
- Windows ARM64 and non-Windows enterprise packages
- General-purpose operating-system egress enforcement

The application controls its own known network behavior. It does not replace Windows Firewall, network segmentation, endpoint security, or gateway-level access control.

## 3. Chosen Approach

The pilot uses an enterprise overlay rather than a hard fork.

The overlay introduces a build/runtime enterprise profile, a company-default configuration layer, a company provider preset, bundled guidance, and a set of feature gates. Existing OpenCode components remain in place where they provide local functionality. In particular, the local sidecar remains responsible for project access, tool execution, permission checks, and communication with the model provider.

A hard fork that physically deletes every public provider and OpenCode integration was rejected for the pilot because it would significantly increase upgrade and regression cost. A central internal control server was also deferred because it adds a new service dependency before the desktop pilot has validated the local workflow.

## 4. Runtime Architecture

The primary request path is:

```text
Windows Desktop UI
  -> authenticated loopback connection
  -> local OpenCode sidecar
  -> Company LLM OpenAI Compatible API
```

The renderer continues to use the existing authenticated loopback server. The sidecar applies configuration, instructions, permissions, filesystem boundaries, and tools before issuing the model request. The enterprise profile is initialized by the desktop main process before the sidecar starts so all child processes receive the same offline feature gates.

The pilot permits these expected destinations:

- The authenticated loopback sidecar
- The configured Company LLM endpoint
- Explicitly configured internal destinations used by project tools, subject to permission rules

No public OpenCode service is required for startup, provider discovery, authentication, sharing, help content, or updates.

## 5. Configuration Model

Configuration is merged in this order, from lowest to highest priority:

1. Application-bundled enterprise defaults
2. User global configuration
3. Project `opencode.jsonc`
4. Optional administrator-managed policy

The new enterprise-default layer is distinct from the existing Windows managed configuration directory. Managed configuration is loaded at high priority and is therefore reserved for future administrator enforcement. It must not be used to implement ordinary company defaults that users are expected to change per project.

Project configuration may override the default provider URL within the packaged internal endpoint allowlist, as well as the model, generation options, additional instructions, and permission choices. The pilot package supplies the allowed internal endpoint patterns; project configuration cannot expand them to public hosts. Build-level offline gates remain non-overridable in the pilot: OpenCode cloud authentication, public sharing, public model-catalog refresh, public update checks, and public default-plugin loading cannot be re-enabled from a project file.

Company defaults are versioned so a diagnostic report can identify the application version, defaults version, and guide version in use.

## 6. Closed-Network Profile

The enterprise profile disables or replaces the following behavior:

- Fetching the public `models.dev` catalog
- OpenCode Console authentication and remote configuration
- Default external authentication and provider plugins
- Public-registry plugin discovery and installation; bundled or explicitly approved local plugins remain available
- Session sharing to OpenCode services
- GitHub-based desktop update checks
- Automatic public LSP downloads
- WSL installation or update paths that use public web downloads
- URL-based instruction loading from public locations
- OpenCode documentation, feedback, GitHub, and Discord links
- Remote notification icons and other public static assets

Model metadata, icons, help content, and company guidance are packaged locally. Public help links are removed or replaced with bundled or internal documentation.

The pilot uses existing offline flags where they fully cover a feature and adds an enterprise profile gate where a path lacks a reliable offline switch. Disabling a UI control alone is insufficient; the underlying main-process or sidecar path must also be disabled.

## 7. Company LLM Provider

The application adds a first-class `Company LLM` preset using `@ai-sdk/openai-compatible`. It does not introduce a separate model-provider implementation.

The preset supports:

- API base URL
- Model ID and a curated model list
- API key or additional authentication headers
- Request timeout
- Context and output token limits
- Streaming, tool-calling, and vision capability metadata
- Additional provider headers required by an internal gateway

The installer may include non-secret defaults such as the API URL, model list, and non-secret headers. API keys, tokens, and secret header values must never be embedded in the installer or written to project configuration. User credentials and secret headers are stored through an Electron secure-storage boundary backed by Windows DPAPI. Decrypted credentials are made available only to the narrow request path that needs them and must not appear in logs or diagnostic exports.

The bundled model list is the offline fallback and always permits startup. If the server provides a reliable `/v1/models` endpoint, the application may refresh the list from that internal endpoint. Failure to refresh does not remove the bundled models or block use of a manually configured model ID.

## 8. Connection Diagnostics and Errors

The provider setup surface includes a `Test connection` action. The sidecar performs the diagnostic through the authenticated local API so it resolves the same configuration, credentials, and provider adapter used by normal chat requests. It checks, in order:

1. URL validity and server reachability
2. TLS and corporate certificate acceptance
3. Authentication
4. Model availability
5. Basic response compatibility
6. Streaming compatibility
7. Tool-calling compatibility when enabled for the selected model

The result distinguishes connection refusal, DNS failure, TLS or certificate failure, timeout, HTTP 401/403, model-not-found responses, malformed OpenAI-compatible responses, unsupported streaming, and unsupported tool calls. Error messages identify the failing layer and a corrective action without exposing secrets. TLS validation uses the Windows trust store, including company certificate authorities installed there; the pilot provides no insecure certificate-validation bypass.

Normal chat requests use the same timeout and compatibility settings as the diagnostic path. Diagnostic logic validates the real provider adapter instead of duplicating provider behavior in a separate client.

## 9. Company Guidance and Pilot Harness

The installer includes a versioned `company-guide.md`. The enterprise-default configuration loads it as a default system instruction for new and existing projects unless a higher-priority user or project configuration adjusts the instruction set.

The application exposes the active guide and its version from a local company-help entry. No internet access is required to read it.

The pilot harness supplies these default permission rules:

- Deny external web search and URL fetching by default
- Ask before accessing files outside the project
- Ask before reading environment or secret files
- Ask before potentially destructive shell operations
- Record local policy decisions and user approvals without recording secrets or prompt contents unnecessarily

Because project settings may adjust these defaults, the pilot harness is a guardrail and guidance mechanism, not an immutable security boundary. Non-overridable organizational controls are deferred to the administrator-managed policy phase.

Guidance content, default settings, and application code remain separate packaging inputs. A future release can update the guide and defaults without rewriting provider or desktop logic, although the pilot still distributes such changes through a new signed installer.

## 10. Windows Packaging and Updates

The pilot produces one code-signed NSIS installer for Windows 10/11 x64. It contains the desktop application, local sidecar, enterprise defaults, curated model metadata, guide, help content, icons, and all required static assets.

The installer uses a per-user one-click flow and does not require internet access. It does not overwrite an existing user configuration merely to restore newer defaults; new bundled defaults remain the lowest-priority layer. Reinstallation or upgrade preserves user configuration, credentials, project files, and local application state. Uninstalling the application does not delete user projects.

GitHub auto-update is disabled for the pilot. New versions are distributed as separately signed installers through the company's existing file-delivery channel. Silent installation, centralized deployment, internal update feeds, and rollback orchestration belong to the post-pilot phase.

## 11. Implementation Boundaries

The work is divided into independently testable areas:

- **Enterprise profile:** owns build identity and non-overridable offline feature gates.
- **Enterprise defaults:** supplies low-priority company configuration and version metadata.
- **Credential store:** owns DPAPI-backed provider secrets and redaction.
- **Company provider setup:** owns the preset, model configuration, and connection test UI.
- **Offline integration cleanup:** removes or replaces public links, assets, downloads, sharing, authentication, and updates.
- **Guide and harness:** owns bundled guidance, default instructions, permissions, and local policy events.
- **Windows packaging:** owns installer contents, signing, persistence behavior, and release artifacts.

These boundaries avoid changes to public Protocol or Server `HttpApi` unless implementation proves that a narrow API addition is required. If a public API does change, generated clients must be regenerated through the repository's prescribed command rather than edited directly.

## 12. Delivery Sequence

1. Establish the enterprise build/runtime profile and offline feature gates.
2. Add the low-priority enterprise-default configuration layer and precedence tests.
3. Add the Company LLM preset, secure credentials, curated models, and diagnostics.
4. Remove or replace public links, assets, downloads, authentication, sharing, and updates.
5. Add bundled guidance and the default permission harness.
6. Produce the Windows x64 installer and verify upgrade/uninstall persistence.
7. Run offline, compatibility, network-audit, and release-candidate verification.

Each stage must leave the ordinary non-enterprise build behavior unchanged unless a shared bug fix is explicitly required.

## 13. Verification Strategy

### Automated tests

- Configuration precedence tests for bundled defaults, user config, project config, and managed policy
- Feature-gate tests proving public integrations cannot initialize in the enterprise profile
- Credential storage and redaction tests
- Permission-default and project-override tests
- Provider integration tests against a local OpenAI-compatible fixture server
- Diagnostic classification tests for authentication, TLS, timeout, model, streaming, and tool-call failures
- Packaging checks that required local assets and defaults are present

Tests run from the owning package directories in accordance with repository rules. Type checking uses `bun typecheck` from each changed package.

### Windows pilot smoke tests

- Clean install on Windows 10 x64 and Windows 11 x64
- First launch with public internet unavailable
- Project open, chat, streaming response, and tool call through the internal API
- Company defaults and guide active on first launch
- Project-level provider, model, instruction, and permission override
- Restart, reinstall, upgrade, and uninstall persistence checks
- Network capture during startup, idle use, provider setup, chat, and shutdown
- Verification that no OpenCode Console, sharing, public model catalog, plugin, LSP, WSL, help, icon, or updater request occurs

## 14. Pilot Acceptance Criteria

The pilot release candidate is accepted when:

- A single installer successfully installs and launches on Windows 10/11 x64.
- The app starts and opens projects with public internet fully blocked.
- Observed application traffic is limited to loopback, the configured internal LLM, and destinations explicitly approved for project tools.
- Standard responses, streaming, and tool calls work against the target OpenAI Compatible API.
- Connection, authentication, TLS, timeout, model, streaming, and tool-call failures produce actionable messages.
- Company model defaults, guide, and permission defaults apply on first launch.
- Project configuration can adjust the designated provider, model, instruction, and permission defaults.
- Known OpenCode cloud, sharing, public plugin, model-catalog, download, help-asset, and update traffic is absent.
- Reinstall and upgrade preserve user configuration and projects, and uninstall does not delete projects.

## 15. Deferred Follow-up

After pilot validation, separate designs may cover administrator-enforced policy, internal guide/model distribution, internal automatic updates with rollback, silent enterprise deployment, centralized audit reporting, and additional Windows architectures.
