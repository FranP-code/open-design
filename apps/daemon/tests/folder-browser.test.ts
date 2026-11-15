import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOpenFolderDialogHandler,
  decideNativeFolderDialog,
  registerFolderBrowserRoutes,
  FOLDER_BROWSER_MAX_ENTRIES,
} from '../src/routes/folder-browser.js';
import { isLocalSameOrigin } from '../src/origin-validation.js';

const REMOTE_ORIGIN = 'https://devbox.example.ts.net:18756';

let tmp: string;
let home: string;
let outside: string;
let recent: string;
let server: http.Server;
let baseUrl: string;
const nativeDialog = vi.fn(async () => '/picked/by/native');
let env: NodeJS.ProcessEnv = {};
let appConfig: { projectLocations?: unknown; recentLinkedDirs?: unknown } = {};

function mkdir(...parts: string[]) {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'od-folder-browser-')));
  home = mkdir(tmp, 'home', 'me');
  outside = mkdir(tmp, 'home', 'me2'); // shares a string prefix with `home`
  recent = mkdir(tmp, 'elsewhere', 'recent-project');
  mkdir(home, 'Projects', 'alpha');
  mkdir(home, 'beta');
  mkdir(home, 'Gamma');
  mkdir(home, '.hidden-dir');
  mkdir(home, '.ssh');
  mkdir(home, '.aws');
  mkdir(home, '.config', 'gh');
  mkdir(home, '.config', 'other');
  mkdir(home, 'Library', 'Keychains');
  mkdir(home, 'Library', 'Other');
  mkdir(home, 'nested', 'deep', '.SSH');
  fs.writeFileSync(path.join(home, 'file.txt'), 'not a dir');
  mkdir(outside, 'secret');
  fs.symlinkSync(outside, path.join(home, 'escape-link'));
  fs.symlinkSync(path.join(home, 'beta'), path.join(home, 'inside-link'));
  const many = mkdir(home, 'many');
  for (let i = 0; i < FOLDER_BROWSER_MAX_ENTRIES + 5; i += 1) {
    fs.mkdirSync(path.join(many, `d${String(i).padStart(5, '0')}`));
  }

  const app = express();
  app.use(express.json());
  const portRef = { current: 0 };
  const gate = (req: express.Request) => isLocalSameOrigin(req, portRef.current, {
    OD_ALLOWED_ORIGINS: REMOTE_ORIGIN,
  } as NodeJS.ProcessEnv);
  app.post('/api/dialog/open-folder', (req, res, next) =>
    createOpenFolderDialogHandler({ isLocalSameOrigin: gate, openNativeFolderDialog: nativeDialog, env })(req, res, next));
  registerFolderBrowserRoutes(app, {
    isLocalSameOrigin: gate,
    readAppConfig: async () => appConfig,
    get env() { return env; },
    homeDir: home,
    hostname: 'test-host',
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  portRef.current = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${portRef.current}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(
  pathname: string,
  init: { method?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? REMOTE_ORIGIN : init.origin;
  if (origin) headers.origin = origin;
  const resp = await fetch(`${baseUrl}${pathname}`, { method: init.method ?? 'GET', headers });
  return { status: resp.status, body: (await resp.json()) as any };
}

const list = (p: string, hidden = false) =>
  call(`/api/folder-browser/list?path=${encodeURIComponent(p)}${hidden ? '&hidden=1' : ''}`);

describe('POST /api/dialog/open-folder', () => {
  it('answers native:false for a remote origin without spawning the dialog', async () => {
    env = {};
    nativeDialog.mockClear();
    const started = Date.now();
    const res = await call('/api/dialog/open-folder', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: null, native: false, reason: 'remote' });
    expect(nativeDialog).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps the native dialog for a loopback origin or no origin in auto mode', async () => {
    env = { OD_NATIVE_FOLDER_DIALOG: 'auto' };
    nativeDialog.mockClear();
    const port = new URL(baseUrl).port;
    const loopback = await call('/api/dialog/open-folder', {
      method: 'POST',
      origin: `http://127.0.0.1:${port}`,
    });
    expect(loopback.body).toEqual({ path: '/picked/by/native' });
    const none = await call('/api/dialog/open-folder', { method: 'POST', origin: null });
    expect(none.body).toEqual({ path: '/picked/by/native' });
    expect(nativeDialog).toHaveBeenCalledTimes(2);
  });

  it('answers reason:disabled when OD_NATIVE_FOLDER_DIALOG=off, even locally', async () => {
    env = { OD_NATIVE_FOLDER_DIALOG: 'off' };
    nativeDialog.mockClear();
    const res = await call('/api/dialog/open-folder', { method: 'POST', origin: null });
    expect(res.body).toEqual({ path: null, native: false, reason: 'disabled' });
    expect(nativeDialog).not.toHaveBeenCalled();
  });

  it('always uses the native dialog when OD_NATIVE_FOLDER_DIALOG=on', async () => {
    env = { OD_NATIVE_FOLDER_DIALOG: 'on' };
    nativeDialog.mockClear();
    const res = await call('/api/dialog/open-folder', { method: 'POST' });
    expect(res.body).toEqual({ path: '/picked/by/native' });
    expect(nativeDialog).toHaveBeenCalledTimes(1);
    env = {};
  });

  it('rejects a cross-origin request before deciding anything', async () => {
    nativeDialog.mockClear();
    const res = await call('/api/dialog/open-folder', { method: 'POST', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(nativeDialog).not.toHaveBeenCalled();
  });

  it('decideNativeFolderDialog treats localhost / [::1] as loopback', () => {
    for (const origin of ['http://localhost:3000', 'http://[::1]:3000', 'http://127.0.0.1']) {
      expect(decideNativeFolderDialog({ headers: { origin } }, {})).toEqual({ native: true });
    }
    expect(decideNativeFolderDialog({ headers: { origin: 'http://192.168.1.5:80' } }, {}))
      .toEqual({ native: false, reason: 'remote' });
  });
});

describe('GET /api/folder-browser/roots', () => {
  it('returns home plus existing project locations and recent dirs, de-duplicated', async () => {
    env = {};
    appConfig = {
      projectLocations: [{ id: 'a', name: 'A', path: path.join(home, 'Projects') }, { id: 'b', name: 'B', path: '/does/not/exist' }],
      recentLinkedDirs: [recent, home, path.join(home, '.ssh')],
    };
    const res = await call('/api/folder-browser/roots');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('test-host');
    expect(res.body.roots.map((r: any) => r.path)).toEqual([home, path.join(home, 'Projects'), recent]);
    expect(res.body.roots[0].label).toBe('~');
    appConfig = {};
  });

  it('uses OD_FOLDER_BROWSER_ROOTS instead of home when set (absolute only)', async () => {
    env = { OD_FOLDER_BROWSER_ROOTS: [path.join(home, 'beta'), 'relative/dir', outside].join(path.delimiter) };
    const res = await call('/api/folder-browser/roots');
    expect(res.body.roots.map((r: any) => r.path)).toEqual([path.join(home, 'beta'), outside]);
    env = {};
  });

  it('rejects cross-origin requests', async () => {
    const res = await call('/api/folder-browser/roots', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/folder-browser/list', () => {
  it('lists only directories, sorted case-insensitively, dot-dirs hidden', async () => {
    const res = await list(home);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(home);
    expect(res.body.root).toBe(home);
    expect(res.body.parent).toBeNull();
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).toEqual(['beta', 'Gamma', 'inside-link', 'Library', 'many', 'nested', 'Projects']);
    expect(names).not.toContain('file.txt');
    expect(res.body.truncated).toBe(false);
  });

  it('shows dot-dirs with hidden=1 but never credential dirs', async () => {
    const res = await list(home, true);
    const names = res.body.entries.map((e: any) => e.name);
    expect(names).toContain('.hidden-dir');
    expect(names).toContain('.config');
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('.aws');
    const config = await list(path.join(home, '.config'), true);
    expect(config.body.entries.map((e: any) => e.name)).toEqual(['other']);
    const lib = await list(path.join(home, 'Library'));
    expect(lib.body.entries.map((e: any) => e.name)).toEqual(['Other']);
  });

  it('keeps Up working inside a recent dir that is also inside home', async () => {
    const nestedRecent = path.join(home, 'Projects', 'alpha');
    appConfig = { recentLinkedDirs: [nestedRecent] };
    try {
      const res = await list(nestedRecent);
      expect(res.status).toBe(200);
      expect(res.body.parent).toBe(path.join(home, 'Projects'));
    } finally {
      appConfig = {};
    }
  });

  it('returns the parent for a nested dir', async () => {
    const res = await list(path.join(home, 'Projects', 'alpha'));
    expect(res.body.parent).toBe(path.join(home, 'Projects'));
    expect(res.body.entries).toEqual([]);
  });

  it('refuses credential dirs at any depth, case-insensitively, with a fixed message', async () => {
    for (const p of [
      path.join(home, '.ssh'),
      path.join(home, '.AWS'),
      path.join(home, '.config', 'gh'),
      path.join(home, 'Library', 'Keychains'),
      path.join(home, 'nested', 'deep', '.SSH'),
    ]) {
      const res = await list(p, true);
      expect(res.status, p).toBe(403);
      expect(res.body.error).toBe('This folder cannot be browsed.');
    }
  });

  it('refuses blocked system dirs and the filesystem root', async () => {
    const root = await list('/');
    expect(root.status).toBe(403);
    if (process.platform !== 'win32') {
      const etc = await list('/etc');
      expect(etc.status).toBe(403);
      expect(etc.body.error).not.toContain('/etc');
    }
  });

  it('uses segment boundaries for containment (me2 is not inside me)', async () => {
    const res = await list(outside);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This folder is outside the browsable locations.');
  });

  it('does not follow a symlink that escapes the roots', async () => {
    const listing = await list(home);
    expect(listing.body.entries.map((e: any) => e.name)).not.toContain('escape-link');
    const inside = listing.body.entries.find((e: any) => e.name === 'inside-link');
    expect(inside.path).toBe(path.join(home, 'beta'));
    const direct = await list(path.join(home, 'escape-link'));
    expect(direct.status).toBe(403);
  });

  it('caps the listing and flags truncation', async () => {
    const res = await list(path.join(home, 'many'));
    expect(res.body.entries).toHaveLength(FOLDER_BROWSER_MAX_ENTRIES);
    expect(res.body.truncated).toBe(true);
  });

  it('answers 400 for missing or relative paths and 404 for missing dirs', async () => {
    expect((await call('/api/folder-browser/list')).status).toBe(400);
    expect((await list('relative/path')).status).toBe(400);
    expect((await list(path.join(home, 'nope'))).status).toBe(404);
    expect((await list(path.join(home, 'file.txt'))).status).toBe(404);
  });

  it('answers 403 for an unreadable dir', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = mkdir(home, 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      const res = await list(locked);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Permission denied/);
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmdirSync(locked);
    }
  });

  it('rejects cross-origin requests', async () => {
    const res = await call(`/api/folder-browser/list?path=${encodeURIComponent(home)}`, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});
