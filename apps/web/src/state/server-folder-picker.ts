// Fork patch (see FORK.md): one imperative entry point for "choose a folder on
// the daemon host".
//
// `POST /api/dialog/open-folder` opens a native dialog on the DAEMON machine.
// When the browser is remote the daemon answers `{ path: null, native: false }`
// instead; this module then opens the in-app ServerFolderPicker (registered by
// <ServerFolderPickerHost/> mounted once at the app root) so callers that are
// not React components can still await a path.

export interface OpenFolderDialogAnswer {
  path?: unknown;
  native?: unknown;
  reason?: unknown;
}

/** What the open-folder request yielded before any in-app fallback. */
export type OpenFolderRequestOutcome =
  | { kind: 'answer'; body: OpenFolderDialogAnswer }
  | { kind: 'http-error'; response: Response }
  | { kind: 'network-error'; error: unknown };

type PickerOpener = () => Promise<string | null>;

let pickerOpener: PickerOpener | null = null;

/**
 * Registers the function that shows the in-app folder picker. Returns an
 * unregister callback. Only the most recent registration is active.
 */
export function registerServerFolderPicker(opener: PickerOpener): () => void {
  pickerOpener = opener;
  return () => {
    if (pickerOpener === opener) pickerOpener = null;
  };
}

export function isServerFolderPickerAvailable(): boolean {
  return pickerOpener !== null;
}

/** Opens the in-app picker; resolves null when none is mounted. */
export function openServerFolderPicker(): Promise<string | null> {
  return pickerOpener ? pickerOpener() : Promise.resolve(null);
}

async function requestOpenFolder(): Promise<OpenFolderRequestOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/dialog/open-folder', { method: 'POST' });
  } catch (error) {
    return { kind: 'network-error', error };
  }
  if (!response.ok) return { kind: 'http-error', response };
  try {
    return { kind: 'answer', body: ((await response.json()) ?? {}) as OpenFolderDialogAnswer };
  } catch (error) {
    return { kind: 'network-error', error };
  }
}

/**
 * Low-level pick used by the existing callers so each keeps its own error
 * semantics. Resolves:
 *  - `{ kind: 'answer' }` from the native dialog (path or cancel), or a
 *    synthetic `{ path }` from the in-app picker;
 *  - the failure outcome only when no in-app picker is mounted, so callers can
 *    keep their legacy error handling.
 */
export async function pickFolderOutcome(): Promise<OpenFolderRequestOutcome> {
  const outcome = await requestOpenFolder();
  const fallBack =
    outcome.kind !== 'answer' || outcome.body.native === false;
  if (!fallBack || !isServerFolderPickerAvailable()) return outcome;
  const picked = await openServerFolderPicker();
  return { kind: 'answer', body: { path: picked } };
}

/** Choose a folder on the daemon host; null when cancelled or unavailable. */
export async function pickFolder(): Promise<string | null> {
  const outcome = await pickFolderOutcome();
  if (outcome.kind !== 'answer') return null;
  const p = outcome.body.path;
  return typeof p === 'string' && p.trim() ? p : null;
}
