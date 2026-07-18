# Skill Toggle Focus Recovery Design

## Goal

Keep the Enterprise Skills settings usable while a bundled skill pack restarts the local sidecar, and ensure closing settings returns keyboard interaction to the UI instead of leaving the prompt inaccessible.

## Confirmed Behavior

- Toggling a skill pack requires an explicit warning because restarting the sidecar can interrupt active provider or tool work.
- The Skills settings dialog remains open after a successful toggle so multiple packs can be changed in one visit.
- Canceling the warning performs no update and does not enter a pending state.
- Confirming the warning closes only the warning layer, starts the existing sidecar update, and keeps the parent settings dialog open.
- While an update is pending, the affected toggle remains disabled through the existing pending state.
- Existing success, rollback, recovery failure, and generic failure behavior remains unchanged.
- When the final settings dialog closes, focus returns to the element that was focused before settings opened when that element is still connected and focusable. Existing session keyboard handling can then route printable input to the prompt.

## Architecture and Data Flow

The Skills settings component will replace the synchronous browser `window.confirm` call with a Promise-backed application dialog. It will use the existing dialog stack `push` operation so the confirmation layer is mounted above the current settings dialog without replacing it. The confirmation component resolves exactly once: cancel resolves `false`; continue resolves `true`; closing the layer through Escape or its overlay also resolves `false`.

`updateSkillPack` will accept an asynchronous confirmation callback. It will wait for confirmation before setting pending state or invoking `platform.enterprise.setSkillPackEnabled`. The existing Enterprise IPC call remains the restart completion boundary because it already returns only after the new sidecar passes its health check or rollback completes.

The shared dialog provider will capture the active HTML element when the first dialog layer is mounted. When the last layer closes, it will restore focus on the next animation frame only when the captured element is still connected and has a callable `focus` method. Pushing or closing a child confirmation layer will not overwrite or prematurely restore the root dialog focus target.

No renderer-to-main restart event is added. The global server SDK already reconnects its SSE stream, and the observed prompt editor remains `contenteditable`; the demonstrated interaction failure is at the modal and focus boundary rather than a disabled editor state.

## Components

### Skill Pack Confirmation

The confirmation dialog lives with the Enterprise Skills settings feature and uses the current application Dialog and button components. It receives the localized warning text and explicit `cancel` and `confirm` callbacks. The Continue action is visually destructive or cautionary according to the closest existing confirmation-dialog pattern.

### Skill Update Coordinator

`updateSkillPack` continues to own the sequence `confirm -> pending -> update -> complete/fail -> clear pending`. Its confirmation callback changes from `() => boolean` to `() => Promise<boolean>` so tests can verify that no update begins while the warning is unresolved.

### Dialog Focus Restoration

The dialog provider owns root-layer focus restoration because it knows when the complete modal stack becomes empty. The provider does not attempt to locate a prompt directly and does not introduce application-specific selectors into the UI package.

## Alternatives Considered

1. **Application confirmation dialog plus root-dialog focus restoration (selected).** This removes the native modal nested inside Kobalte, preserves the settings workflow, and fixes focus at the shared modal boundary.
2. **Add a sidecar-restarted IPC event and force the renderer event stream to restart.** This broadens the Desktop and application contracts without evidence that server health disables editing. It can be reconsidered if reconnect instrumentation later shows a distinct stale-stream defect.
3. **Relaunch the complete Desktop application after every toggle.** This reliably rebuilds renderer state but disrupts sessions and defeats the goal of changing several packs in one settings visit.

## Error and Edge-Case Handling

- Escape, overlay dismissal, and Cancel resolve an outstanding confirmation as canceled once.
- Repeated resolution attempts are ignored so closing animation callbacks cannot start duplicate updates.
- A sidecar restart failure continues to display the current localized rollback or recovery error in the Skills settings section.
- Focus is not restored to a removed or disconnected element.
- Closing a child dialog restores focus within the parent through Kobalte's normal behavior; shared root restoration runs only after the final dialog leaves the stack.
- Existing `ResizeObserver` warnings and duplicate `input.focus` registrations are outside this change because neither is uniquely caused by skill-pack restart.

## Verification

- Add a failing Skills settings regression test proving asynchronous confirmation must resolve before pending state or IPC update begins.
- Verify cancel leaves pending state and update untouched.
- Verify confirm preserves the current pending, completion, and failure ordering.
- Add dialog-provider coverage for capturing the root focus target, ignoring child-layer closes, restoring after the final close, and skipping disconnected targets.
- Verify the Skills implementation no longer calls `window.confirm` and opens confirmation as a pushed layer.
- Run focused tests from `packages/app` and `packages/ui` as required by the touched files.
- Run `bun typecheck` from each touched package.
- In Enterprise Desktop, open Skills from a session, confirm a pack toggle, wait for the sidecar restart, close settings, and verify typing reaches the current prompt.

## Scope

This change does not alter skill-pack persistence, catalog validation, sidecar rollback, public Server `HttpApi`, Protocol, generated clients, skill discovery, or pack defaults. It does not introduce a full Desktop relaunch or modify unrelated SolidJS lifecycle and ResizeObserver warnings.
