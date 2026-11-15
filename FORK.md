# Fork notes: server-side folder browser

This fork (`FranP-code/open-design`, branch `server-folder-browser`, based on
`devbox` = upstream `1b47e60b`, v0.23.1) carries one self-contained stopgap patch.
Drop it once upstream ships its own fix.

## Why

Every "Choose folder", "Link local code" and "Add folder" button in the web UI calls
`POST /api/dialog/open-folder`. That route opens a **native** dialog
(`osascript choose folder`, zenity, PowerShell) on the **daemon host**. When the web UI
is used from another machine (Tailscale serve, an nginx reverse proxy), the dialog opens
invisibly on the daemon's screen and hangs for 120 s. The web reads the `null` as
"cancelled", so the button does nothing.

Upstream tracks this in nexu-io/open-design#6576, with draft PR nexu-io/open-design#8136
(earlier attempts: #6586, #4211, #7570, all closed).

## What the patch changes

### Daemon

- `apps/daemon/src/routes/folder-browser.ts` (new): all daemon logic.
  - `POST /api/dialog/open-folder` (handler moved here; the route still lives in
    `routes/media.ts`). The existing `isLocalSameOrigin` gate runs first. Then it decides,
    **before spawning anything**:
    - `OD_NATIVE_FOLDER_DIALOG=auto` (default): native dialog only when the request's
      `Origin` hostname is loopback (`127.0.0.1`, `localhost`, `::1`) or there is no
      Origin header (or the Origin is not http/https, e.g. a desktop shell scheme).
      Otherwise it answers at once `200 {"path":null,"native":false,"reason":"remote"}`.
    - `OD_NATIVE_FOLDER_DIALOG=off`: always `{"path":null,"native":false,"reason":"disabled"}`.
    - `OD_NATIVE_FOLDER_DIALOG=on`: always native (the old behaviour).
  - `GET /api/folder-browser/roots` → `{ host, roots: [{ path, label }] }`. Roots are
    `OD_FOLDER_BROWSER_ROOTS` (split on `path.delimiter`, absolute paths only) or, if
    unset, the user's home dir, plus the app-config `projectLocations` paths and
    `recentLinkedDirs` that exist. Canonicalized with realpath, de-duplicated, missing
    ones dropped.
  - `GET /api/folder-browser/list?path=<abs>&hidden=0|1` →
    `{ path, root, parent, entries: [{ name, path }], truncated }`. Read-only, directories
    only, max 2000 entries.
- `apps/daemon/src/routes/media.ts`: the open-folder route uses the new handler, and the
  folder-browser routes are registered next to it. Only a few lines change.
- `apps/daemon/tests/folder-browser.test.ts` (new).

### Web

- `apps/web/src/state/server-folder-picker.ts` (new): `pickFolder()` and
  `pickFolderOutcome()`. Both POST open-folder. On `native:false`, or when the request
  fails (403/500/network), they open the in-app picker. A native answer (a path, or
  `{path:null}` for "cancelled") resolves as before. If no picker is mounted, failures
  reach the caller unchanged, so legacy error handling still works.
- `apps/web/src/components/ServerFolderPicker.tsx` + `.module.css` (new): the modal
  "Choose a folder on <host>" (root shortcuts, editable path, Up, subfolder list, Show
  hidden, loading/empty/error states, Select/Cancel, Esc and backdrop cancel, focus trap,
  full screen on phone widths) and `ServerFolderPickerHost`, which registers the picker
  with the module above.
- `apps/web/src/App.tsx`: mounts `<ServerFolderPickerHost/>` once (inside the
  `I18nProvider` from `app/layout.tsx`).
- `apps/web/app/layout.tsx`: imports the picker CSS module (same lazy-chunk reason as
  the existing host CSS imports there).
- Callers routed through the new module, with signatures and error behaviour kept:
  `providers/registry.ts` `openFolderDialog()`, `state/projects.ts`
  `pickLocalFolderPath()`, `state/project-locations.ts`
  `openProjectLocationFolderDialog()`.
- i18n: `serverFolderPicker.*` keys in `i18n/types.ts`, `locales/en.ts`, and English text
  in every other locale (the locale files are type-checked as complete).
- `apps/web/tests/components/ServerFolderPicker.test.tsx` (new).

`packages/contracts` is unchanged on purpose. The response types live in the daemon and
web code, so no package rebuild is needed.

The desktop (Electron) path (`isOpenDesignHostAvailable()` / `pickHostWorkingDir`) is
unchanged. A browser on the daemon machine keeps the native dialog in `auto` mode.

## Security notes

- Same `isLocalSameOrigin` gate as `/api/dir-exists`, so only allowed origins
  (`OD_ALLOWED_ORIGINS`, loopback, same-origin LAN) can call the endpoints.
- Read-only: no mkdir, write, or delete. Only directory names are returned, never file
  names.
- `path` is canonicalized with realpath and must be equal to or inside a root.
  Containment is checked on path-segment boundaries (`/Users/franp2` is not inside
  `/Users/franp`).
- Symlinked directories are listed only if their realpath is also inside a root. A
  symlink that escapes a root is neither listed nor browsable.
- Always refused with a fixed 403 message (no host details): anything
  `linked-dirs.ts#isBlocked()` rejects (filesystem root, `/etc`, `/proc`, `/sys`, `/dev`,
  `/boot`, Windows system dirs), and credential dirs at any depth, case-insensitive:
  `.ssh .aws .gnupg .kube .docker .config/gh Library/Keychains`. These are also hidden
  from listings.
- Unreadable dirs (EACCES/EPERM, e.g. macOS TCC-protected folders) → 403 with a clear
  message. Missing dir → 404. Missing or relative path → 400.
- Anyone who can reach an allowed origin can see directory names under the roots. To
  limit that, set `OD_FOLDER_BROWSER_ROOTS` to the folders you want to expose.

## Env vars

| Var | Values | Default |
| --- | --- | --- |
| `OD_NATIVE_FOLDER_DIALOG` | `auto` \| `off` \| `on` | `auto` |
| `OD_FOLDER_BROWSER_ROOTS` | `path.delimiter`-separated absolute paths | user's home dir |

## Decisions made while building (headless, no one to ask)

- In `auto` mode, a non-http(s) Origin (e.g. a desktop shell custom scheme) counts as
  local and keeps the native dialog, so desktop behaviour cannot regress.
- If open-folder fails and no picker host is mounted (unit tests, a future embed),
  callers keep their legacy error behaviour instead of resolving `null` silently.
- Opening a second pick while the picker is showing cancels the first (resolves `null`).
- The root list follows the spec in full: recent linked dirs and project locations
  become extra roots even when they are outside home.
- Non-English locales get the English text (the strings are a stopgap, and machine
  translation would add review noise to a patch meant to be dropped).

## Production on the devbox

`~/open-design` on the devbox runs this branch under pm2 (`opendesign`, daemon 7456, web 8756),
reached at https://opendesign.pessano.dev and https://devbox-vm.taild2a0ad.ts.net:8756.

- It is tracked by a git dir kept **outside** the tree, `~/.open-design.git`, so neither the
  daemon nor the agents it spawns see a `.git` folder inside the app. Use
  `git --git-dir=$HOME/.open-design.git --work-tree=$HOME/open-design …` (alias `odgit`).
- The install was unpacked from a tarball without `e2e/`, `docs/`, `specs/`, `.github/`, so
  `odgit status` lists those as deleted. That's expected; the deploy script ignores them.
- Remotes there: `origin` = this fork, `upstream` = nexu-io/open-design.

Deploy a new commit of this branch (push it first):

```bash
~/open-design/scripts/fork-deploy.sh --dry-run   # what would change
~/open-design/scripts/fork-deploy.sh             # snapshot, checkout, build, restart, health check
~/open-design/scripts/fork-deploy.sh --rollback  # back to the pre-deploy snapshot
```

The script refuses to run while an OpenDesign run is in progress or when the tree has local
edits. It snapshots code and build output (not `node_modules`, not `.od` data) to
`~/backups/open-design-pre-fork` and rolls back by itself if a build or the health check fails.
The web build needs the server stopped, so expect about a minute of downtime.

## Leaving the fork (migrating back to upstream)

A daily Hermes cron job (`opendesign fork exit watch`) checks upstream and pings once
#8136 is merged and a stable release contains it, or if #6576 is closed by some other fix.
Then, on the devbox:

1. Backup: `~/opendesign-backup/sync.sh -m "before upstream migration"`.
2. Read the upstream release notes from 0.23.1 up to the target tag `<tag>`
   (data migrations, config changes, Node version in `.node-version`).
3. `odgit fetch upstream --tags`
4. Make sure no OpenDesign run is in progress, then `pm2 stop opendesign`.
5. `odgit checkout -B upstream <tag>` (the fork's files go away with it; `FORK.md` and
   `scripts/fork-deploy.sh` too, so copy the script to `/tmp` first if you want its rollback).
6. `cd ~/open-design && pnpm install --frozen-lockfile && pnpm --filter @open-design/daemon build && pnpm --filter @open-design/web build`
7. If `OD_NATIVE_FOLDER_DIALOG` or `OD_FOLDER_BROWSER_ROOTS` were added to `.env-od`,
   remove them (fork-only).
8. `pm2 start opendesign`, then `curl -s 127.0.0.1:7456/api/health`.
9. From another machine, open https://opendesign.pessano.dev → Working directory →
   Choose folder. Upstream's picker must open in the browser.
10. Rollback if it misbehaves: `pm2 stop opendesign; odgit checkout server-folder-browser`,
    rebuild as in step 6, `pm2 start opendesign`.
11. When it's good: archive the fork (`gh repo archive FranP-code/open-design`), update the
    `opendesign` skill and homelab-docker `docs/opendesign.md` (version, no fork), and remove the
    `opendesign fork exit watch` cron job.

## Dropping this fork

The patch becomes unnecessary once upstream ships nexu-io/open-design#8136 (or its
successor) and fixes #6576. Then:

1. Rebase onto upstream without this patch (revert the `server-folder-browser` commits).
   Every touched spot is marked `Fork patch (see FORK.md)`.
2. The endpoints `/api/folder-browser/roots`, `/api/folder-browser/list` and the
   `native`/`reason` fields of `/api/dialog/open-folder` disappear.
3. Remove `OD_NATIVE_FOLDER_DIALOG` and `OD_FOLDER_BROWSER_ROOTS` from the daemon env
   (`~/open-design/.env-od` on the devbox), and use whatever upstream documents instead.
4. Delete this file.
