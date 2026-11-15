// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerFolderPickerHost } from '../../src/components/ServerFolderPicker';
import { pickFolder } from '../../src/state/server-folder-picker';
import { openFolderDialog } from '../../src/providers/registry';
import { pickLocalFolderPath } from '../../src/state/projects';
import { openProjectLocationFolderDialog } from '../../src/state/project-locations';

const HOME = '/srv/home/me';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type DialogAnswer = Response | Error;

function installFetch(dialog: () => DialogAnswer) {
  const mock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === '/api/dialog/open-folder') {
      const answer = dialog();
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (url === '/api/folder-browser/roots') {
      return json({ host: 'devbox', roots: [{ path: HOME, label: '~' }, { path: '/srv/data', label: '/srv/data' }] });
    }
    if (url === '/api/recent-dirs') {
      return json({ dirs: ['/outside/root', `${HOME}/Projects`] });
    }
    if (url.startsWith('/api/folder-browser/list?')) {
      const params = new URLSearchParams(url.split('?')[1]);
      const p = params.get('path')!;
      if (p === '/nope') return json({ error: 'Folder not found' }, 404);
      if (p === `${HOME}/Projects`) {
        return json({ path: p, root: HOME, parent: HOME, entries: [{ name: 'alpha', path: `${p}/alpha` }], truncated: false });
      }
      if (p === `${HOME}/Projects/alpha`) {
        return json({ path: p, root: HOME, parent: `${HOME}/Projects`, entries: [], truncated: false });
      }
      return json({ path: p, root: p, parent: null, entries: [{ name: 'Projects', path: `${HOME}/Projects` }], truncated: false });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const remoteAnswer = () => json({ path: null, native: false, reason: 'remote' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pickFolder without the in-app picker mounted', () => {
  it('returns the native dialog path', async () => {
    installFetch(() => json({ path: '/Users/me/Site' }));
    await expect(pickFolder()).resolves.toBe('/Users/me/Site');
  });

  it('returns null on a native cancel', async () => {
    installFetch(() => json({ path: null }));
    await expect(pickFolder()).resolves.toBeNull();
  });

  it('keeps legacy caller error behaviour when no picker is mounted', async () => {
    installFetch(() => json({ error: 'cross-origin request rejected' }, 403));
    await expect(pickLocalFolderPath()).rejects.toThrow('cross-origin request rejected');
    await expect(openFolderDialog()).resolves.toBeNull();
    await expect(openFolderDialog({ throwOnError: true })).rejects.toThrow('cross-origin request rejected');
  });
});

describe('pickFolder with <ServerFolderPickerHost/> mounted', () => {
  beforeEach(() => {
    render(<ServerFolderPickerHost />);
  });

  it('does not open the picker for a native path or a native cancel', async () => {
    installFetch(() => json({ path: '/Users/me/Site' }));
    await expect(pickFolder()).resolves.toBe('/Users/me/Site');
    installFetch(() => json({ path: null }));
    await expect(pickFolder()).resolves.toBeNull();
    expect(screen.queryByTestId('server-folder-picker')).toBeNull();
  });

  it('native:false opens the picker at the most recent dir inside a root, then selects', async () => {
    installFetch(remoteAnswer);
    let result: Promise<string | null>;
    await act(async () => {
      result = pickFolder();
    });
    expect(await screen.findByText('Choose a folder on devbox')).toBeTruthy();
    // Opens at the recent dir that is inside a root (the first recent is outside).
    const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(`${HOME}/Projects`));
    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(input.value).toBe(`${HOME}/Projects/alpha`));
    expect(await screen.findByText('No subfolders')).toBeTruthy();
    fireEvent.click(screen.getByText('Select this folder'));
    await expect(result!).resolves.toBe(`${HOME}/Projects/alpha`);
    await waitFor(() => expect(screen.queryByTestId('server-folder-picker')).toBeNull());
  });

  it('Up, typed path + Enter, and inline error work', async () => {
    installFetch(remoteAnswer);
    let result: Promise<string | null>;
    await act(async () => {
      result = pickFolder();
    });
    const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(`${HOME}/Projects`));
    fireEvent.click(screen.getByLabelText('Up one level'));
    await waitFor(() => expect(input.value).toBe(HOME));
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Folder not found');
    expect((screen.getByText('Select this folder') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Cancel'));
    await expect(result!).resolves.toBeNull();
  });

  it('picker cancel (Esc, backdrop) resolves null', async () => {
    installFetch(remoteAnswer);
    let result: Promise<string | null>;
    await act(async () => {
      result = pickFolder();
    });
    const dialog = await screen.findByTestId('server-folder-picker');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await expect(result!).resolves.toBeNull();

    await act(async () => {
      result = pickFolder();
    });
    const again = await screen.findByTestId('server-folder-picker');
    fireEvent.click(again.parentElement!);
    await expect(result!).resolves.toBeNull();
  });

  it('a 403 from open-folder falls back to the picker', async () => {
    installFetch(() => json({ error: 'cross-origin request rejected' }, 403));
    let result: Promise<string | null>;
    await act(async () => {
      result = pickLocalFolderPath();
    });
    const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(`${HOME}/Projects`));
    fireEvent.click(screen.getByText('Select this folder'));
    await expect(result!).resolves.toBe(`${HOME}/Projects`);
  });

  it('a network error falls back to the picker (all three callers)', async () => {
    installFetch(() => new TypeError('Failed to fetch'));
    for (const caller of [
      () => openFolderDialog({ throwOnError: true }),
      () => openProjectLocationFolderDialog(),
      () => pickLocalFolderPath(),
    ]) {
      let result: Promise<string | null>;
      await act(async () => {
        result = caller();
      });
      const input = (await screen.findByLabelText('Folder path')) as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe(`${HOME}/Projects`));
      fireEvent.click(screen.getByText('Select this folder'));
      await expect(result!).resolves.toBe(`${HOME}/Projects`);
      await waitFor(() => expect(screen.queryByTestId('server-folder-picker')).toBeNull());
    }
  });
});
