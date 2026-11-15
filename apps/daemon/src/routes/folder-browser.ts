// Fork patch (see FORK.md): server-side folder browser for remote web UIs.
//
// `POST /api/dialog/open-folder` spawns a native dialog on the DAEMON host.
// When the browser runs on another machine that dialog is invisible, so this
// module (1) decides up front whether a native dialog makes sense for the
// request, and (2) exposes a read-only directory listing the web UI renders in
// its own picker instead. Self-contained on purpose so it is easy to drop once
// upstream ships nexu-io/open-design#8136.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, RequestHandler } from 'express';
import { isBlocked } from '../linked-dirs.js';

export type NativeFolderDialogMode = 'auto' | 'off' | 'on';

export type NativeFolderDialogDecision =
  | { native: true }
  | { native: false; reason: 'remote' | 'disabled' };

export interface FolderBrowserRoot {
  path: string;
  label: string;
}

export interface FolderBrowserRootsResponse {
  host: string;
  roots: FolderBrowserRoot[];
}

export interface FolderBrowserEntry {
  name: string;
  path: string;
}

export interface FolderBrowserListResponse {
  path: string;
  root: string;
  parent: string | null;
  entries: FolderBrowserEntry[];
  truncated: boolean;
}

export const FOLDER_BROWSER_MAX_ENTRIES = 2000;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Segment sequences refused at any depth (compared case-insensitively).
const CREDENTIAL_SEGMENTS: string[][] = [
  ['.ssh'],
  ['.aws'],
  ['.gnupg'],
  ['.kube'],
  ['.docker'],
  ['.config', 'gh'],
  ['library', 'keychains'],
];

const REFUSED_MESSAGE = 'This folder cannot be browsed.';
const OUTSIDE_MESSAGE = 'This folder is outside the browsable locations.';
const UNREADABLE_MESSAGE = 'Permission denied: this folder cannot be read by the OpenDesign daemon.';

export function resolveNativeFolderDialogMode(env: NodeJS.ProcessEnv = process.env): NativeFolderDialogMode {
  const raw = String(env.OD_NATIVE_FOLDER_DIALOG ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'on') return raw;
  return 'auto';
}

/**
 * Whether the request's browser is on the daemon host. Only an http(s)
 * Origin with a non-loopback hostname counts as remote; no Origin (same-origin
 * GET, curl, desktop shell) or a non-http Origin keeps the native dialog.
 */
export function isRemoteBrowserRequest(req: Pick<Request, 'headers'>): boolean {
  const raw = req.headers?.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
}

export function decideNativeFolderDialog(
  req: Pick<Request, 'headers'>,
  env: NodeJS.ProcessEnv = process.env,
): NativeFolderDialogDecision {
  const mode = resolveNativeFolderDialogMode(env);
  if (mode === 'on') return { native: true };
  if (mode === 'off') return { native: false, reason: 'disabled' };
  return isRemoteBrowserRequest(req) ? { native: false, reason: 'remote' } : { native: true };
}

export interface OpenFolderDialogHandlerDeps {
  isLocalSameOrigin: (req: Request) => boolean;
  openNativeFolderDialog: () => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
}

/** Handler for `POST /api/dialog/open-folder`. */
export function createOpenFolderDialogHandler(deps: OpenFolderDialogHandlerDeps): RequestHandler {
  return async (req, res) => {
    if (!deps.isLocalSameOrigin(req)) {
      res.status(403).json({ error: 'cross-origin request rejected' });
      return;
    }
    const decision = decideNativeFolderDialog(req, deps.env ?? process.env);
    if (!decision.native) {
      res.json({ path: null, native: false, reason: decision.reason });
      return;
    }
    try {
      const selected = await deps.openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function hasCredentialSegments(target: string): boolean {
  const segments = path
    .resolve(target)
    .split(path.sep)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return CREDENTIAL_SEGMENTS.some((seq) => {
    for (let i = 0; i + seq.length <= segments.length; i += 1) {
      if (seq.every((s, j) => segments[i + j] === s)) return true;
    }
    return false;
  });
}

/** Paths the browser never lists or opens, whatever the roots say. */
export function isRefusedFolder(realPath: string): boolean {
  return isBlocked(realPath) || hasCredentialSegments(realPath);
}

async function canonicalDir(p: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(p);
    const stat = await fs.promises.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export interface FolderBrowserDeps {
  isLocalSameOrigin: (req: Request) => boolean;
  /** Reads the daemon app config (projectLocations, recentLinkedDirs). */
  readAppConfig: () => Promise<{ projectLocations?: unknown; recentLinkedDirs?: unknown } | null | undefined>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  hostname?: string;
}

export async function resolveFolderBrowserRoots(deps: FolderBrowserDeps): Promise<FolderBrowserRoot[]> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? os.homedir();
  const configured = String(env.OD_FOLDER_BROWSER_ROOTS ?? '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s && path.isAbsolute(s));
  const candidates = configured.length > 0 ? configured : [home];

  let config: Awaited<ReturnType<FolderBrowserDeps['readAppConfig']>> = null;
  try {
    config = await deps.readAppConfig();
  } catch {
    config = null;
  }
  if (Array.isArray(config?.projectLocations)) {
    for (const loc of config.projectLocations) {
      if (loc && typeof loc.path === 'string' && path.isAbsolute(loc.path)) candidates.push(loc.path);
    }
  }
  if (Array.isArray(config?.recentLinkedDirs)) {
    for (const dir of config.recentLinkedDirs) {
      if (typeof dir === 'string' && path.isAbsolute(dir)) candidates.push(dir);
    }
  }

  const realHome = (await canonicalDir(home)) ?? home;
  const seen = new Set<string>();
  const roots: FolderBrowserRoot[] = [];
  for (const candidate of candidates) {
    const real = await canonicalDir(candidate);
    if (!real || seen.has(real) || isRefusedFolder(real)) continue;
    seen.add(real);
    let label = real;
    if (real === realHome) label = '~';
    else if (isWithin(realHome, real)) label = `~${path.sep}${path.relative(realHome, real)}`;
    roots.push({ path: real, label });
  }
  return roots;
}

class FolderBrowserError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function listFolder(
  deps: FolderBrowserDeps,
  rawPath: unknown,
  showHidden: boolean,
): Promise<FolderBrowserListResponse> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new FolderBrowserError(400, 'path is required');
  }
  if (!path.isAbsolute(rawPath)) {
    throw new FolderBrowserError(400, 'path must be absolute');
  }
  let real: string;
  try {
    real = await fs.promises.realpath(rawPath);
    const stat = await fs.promises.stat(real);
    if (!stat.isDirectory()) throw new FolderBrowserError(404, 'Folder not found');
  } catch (err: any) {
    if (err instanceof FolderBrowserError) throw err;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') throw new FolderBrowserError(403, UNREADABLE_MESSAGE);
    throw new FolderBrowserError(404, 'Folder not found');
  }
  if (isRefusedFolder(real)) throw new FolderBrowserError(403, REFUSED_MESSAGE);

  const roots = await resolveFolderBrowserRoots(deps);
  const containing = roots
    .filter((r) => isWithin(r.path, real))
    .sort((a, b) => b.path.length - a.path.length);
  const root = containing[0];
  if (!root) throw new FolderBrowserError(403, OUTSIDE_MESSAGE);
  const insideSomeRoot = (p: string) => roots.some((r) => isWithin(r.path, p));

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(real, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') throw new FolderBrowserError(403, UNREADABLE_MESSAGE);
    throw new FolderBrowserError(404, 'Folder not found');
  }

  const entries: FolderBrowserEntry[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!showHidden && name.startsWith('.')) continue;
    const full = path.join(real, name);
    let entryPath: string;
    if (dirent.isDirectory()) {
      entryPath = full;
    } else if (dirent.isSymbolicLink()) {
      const target = await canonicalDir(full);
      if (!target || !insideSomeRoot(target)) continue;
      entryPath = target;
    } else {
      continue;
    }
    if (isRefusedFolder(entryPath)) continue;
    entries.push({ name, path: entryPath });
  }
  entries.sort((a, b) => {
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const truncated = entries.length > FOLDER_BROWSER_MAX_ENTRIES;

  return {
    path: real,
    root: root.path,
    // Up stays possible while the parent is inside ANY root: recent dirs are
    // roots too, so using only the deepest match would strand the user there.
    parent: (() => {
      const up = path.dirname(real);
      return up !== real && insideSomeRoot(up) && !isRefusedFolder(up) ? up : null;
    })(),
    entries: truncated ? entries.slice(0, FOLDER_BROWSER_MAX_ENTRIES) : entries,
    truncated,
  };
}

export function registerFolderBrowserRoutes(app: Express, deps: FolderBrowserDeps) {
  app.get('/api/folder-browser/roots', async (req, res) => {
    if (!deps.isLocalSameOrigin(req)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const body: FolderBrowserRootsResponse = {
        host: deps.hostname ?? os.hostname(),
        roots: await resolveFolderBrowserRoots(deps),
      };
      res.json(body);
    } catch {
      res.status(500).json({ error: 'Could not read browsable locations' });
    }
  });

  app.get('/api/folder-browser/list', async (req, res) => {
    if (!deps.isLocalSameOrigin(req)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const body = await listFolder(deps, req.query.path, req.query.hidden === '1');
      res.json(body);
    } catch (err) {
      if (err instanceof FolderBrowserError) {
        return res.status(err.status).json({ error: err.message });
      }
      res.status(500).json({ error: 'Could not list folder' });
    }
  });
}
