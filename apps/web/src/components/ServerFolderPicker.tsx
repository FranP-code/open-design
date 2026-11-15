// Fork patch (see FORK.md): in-app folder picker that browses the DAEMON
// host's filesystem through the read-only `/api/folder-browser/*` endpoints.
// Shown when the native dialog cannot reach the user (remote browser).
//
// <ServerFolderPickerHost/> is mounted once at the app root and registers
// itself with `state/server-folder-picker.ts`, so non-React callers can await
// a pick via `pickFolder()`.

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { modalOverlay, modalContent } from '../motion';
import { useT } from '../i18n';
import { registerServerFolderPicker } from '../state/server-folder-picker';
import styles from './ServerFolderPicker.module.css';

interface FolderBrowserRoot {
  path: string;
  label: string;
}

interface FolderBrowserListing {
  path: string;
  root: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
}

async function readError(resp: Response): Promise<string | null> {
  try {
    const body = (await resp.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* fall through */
  }
  return null;
}

async function fetchRoots(): Promise<{ host: string; roots: FolderBrowserRoot[] }> {
  const resp = await fetch('/api/folder-browser/roots');
  if (!resp.ok) throw new Error((await readError(resp)) ?? `Request failed (${resp.status}).`);
  const body = (await resp.json()) as { host?: unknown; roots?: unknown };
  return {
    host: typeof body.host === 'string' ? body.host : '',
    roots: Array.isArray(body.roots)
      ? body.roots.filter((r): r is FolderBrowserRoot => !!r && typeof r.path === 'string')
      : [],
  };
}

async function fetchListing(path: string, hidden: boolean): Promise<FolderBrowserListing> {
  const qs = `path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`;
  const resp = await fetch(`/api/folder-browser/list?${qs}`);
  if (!resp.ok) throw new Error((await readError(resp)) ?? `Request failed (${resp.status}).`);
  return (await resp.json()) as FolderBrowserListing;
}

async function fetchRecentDirs(): Promise<string[]> {
  try {
    const resp = await fetch('/api/recent-dirs');
    if (!resp.ok) return [];
    const body = (await resp.json()) as { dirs?: unknown };
    return Array.isArray(body.dirs) ? body.dirs.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const base = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${root.includes('\\') ? '\\' : '/'}`;
  return target.startsWith(base);
}

interface ServerFolderPickerProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export function ServerFolderPicker({ onSelect, onCancel }: ServerFolderPickerProps) {
  const t = useT();
  const [host, setHost] = useState('');
  const [roots, setRoots] = useState<FolderBrowserRoot[]>([]);
  const [rootsLoaded, setRootsLoaded] = useState(false);
  const [listing, setListing] = useState<FolderBrowserListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

  const navigate = useCallback(async (target: string, hidden = showHiddenRef.current) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchListing(target, hidden);
      if (seq !== requestSeq.current) return;
      setListing(next);
      setPathInput(next.path);
      // The clicked entry is gone after a navigation; keep keyboard focus in
      // the dialog instead of letting it fall back to <body>.
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
        pathInputRef.current?.focus();
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error && err.message ? err.message : t('serverFolderPicker.loadError'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rootsBody, recents] = await Promise.all([fetchRoots(), fetchRecentDirs()]);
        if (cancelled) return;
        setHost(rootsBody.host);
        setRoots(rootsBody.roots);
        setRootsLoaded(true);
        const start =
          recents.find((dir) => rootsBody.roots.some((r) => isInside(r.path, dir)))
          ?? rootsBody.roots[0]?.path;
        if (start) {
          await navigate(start);
        } else {
          setLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        setRootsLoaded(true);
        setLoading(false);
        setError(err instanceof Error && err.message ? err.message : t('serverFolderPicker.loadError'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, t]);

  useEffect(() => {
    pathInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [onCancel]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // Keep Tab focus inside the dialog.
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submitPath = (e: FormEvent) => {
    e.preventDefault();
    const target = pathInput.trim();
    if (target) void navigate(target);
  };

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    if (listing) void navigate(listing.path, next);
  };

  const title = host
    ? t('serverFolderPicker.title', { host })
    : t('serverFolderPicker.titleFallback');
  const canSelect = !!listing && !loading && !error;

  const modal = (
    <motion.div
      className={styles.backdrop}
      onClick={onCancel}
      variants={modalOverlay}
      initial="hidden"
      animate="visible"
      exit="exit"
      role="presentation"
    >
      <motion.div
        ref={dialogRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        variants={modalContent}
        initial="hidden"
        animate="visible"
        exit="exit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-folder-picker-title"
        data-testid="server-folder-picker"
      >
        <header className={styles.head}>
          <span className={styles.headTitle} id="server-folder-picker-title">
            <Icon name="folder" size={16} /> {title}
          </span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onCancel}
            aria-label={t('serverFolderPicker.close')}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {roots.length > 0 ? (
          <nav className={styles.roots} aria-label={t('serverFolderPicker.locations')}>
            {roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className={styles.rootChip}
                data-active={listing?.root === root.path && listing.path === root.path}
                onClick={() => void navigate(root.path)}
                title={root.path}
              >
                {root.label}
              </button>
            ))}
          </nav>
        ) : null}

        <form className={styles.pathRow} onSubmit={submitPath}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => listing?.parent && void navigate(listing.parent)}
            disabled={!listing?.parent || loading}
            aria-label={t('serverFolderPicker.up')}
            title={t('serverFolderPicker.up')}
          >
            <Icon name="arrow-up" size={16} />
          </button>
          <input
            ref={pathInputRef}
            className={styles.pathInput}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            aria-label={t('serverFolderPicker.pathLabel')}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <Button type="submit" variant="ghost" size="sm" disabled={!pathInput.trim()}>
            {t('serverFolderPicker.go')}
          </Button>
        </form>

        <label className={styles.hiddenToggle}>
          <input type="checkbox" checked={showHidden} onChange={toggleHidden} />
          {t('serverFolderPicker.showHidden')}
        </label>

        <div className={styles.listWrap}>
          {error ? (
            <p className={styles.error} role="alert">{error}</p>
          ) : loading ? (
            <p className={styles.state}>
              <Icon name="spinner" size={14} className={styles.spin} /> {t('serverFolderPicker.loading')}
            </p>
          ) : rootsLoaded && roots.length === 0 ? (
            <p className={styles.state}>{t('serverFolderPicker.noRoots')}</p>
          ) : listing && listing.entries.length === 0 ? (
            <p className={styles.state}>{t('serverFolderPicker.empty')}</p>
          ) : listing ? (
            <ul className={styles.list}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={styles.entry}
                    onClick={() => void navigate(entry.path)}
                    title={entry.path}
                  >
                    <Icon name="folder" size={15} className={styles.entryIcon} />
                    <span className={styles.entryName}>{entry.name}</span>
                  </button>
                </li>
              ))}
              {listing.truncated ? (
                <li className={styles.state}>
                  {t('serverFolderPicker.truncated', { count: listing.entries.length })}
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>

        <footer className={styles.foot}>
          <span className={styles.currentPath} title={listing?.path ?? ''}>
            {listing?.path ?? ''}
          </span>
          <div className={styles.footActions}>
            <Button variant="ghost" onClick={onCancel}>{t('serverFolderPicker.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => listing && onSelect(listing.path)}
              disabled={!canSelect}
            >
              {t('serverFolderPicker.select')}
            </Button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );

  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}

/**
 * Mount once at the app root. Registers the picker with
 * `state/server-folder-picker.ts` and renders it while a pick is pending.
 */
export function ServerFolderPickerHost() {
  const [pending, setPending] = useState<{ resolve: (path: string | null) => void } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    const unregister = registerServerFolderPicker(
      () =>
        new Promise<string | null>((resolve) => {
          // A second open while one is showing cancels the first.
          pendingRef.current?.resolve(null);
          setPending({ resolve });
        }),
    );
    return () => {
      unregister();
      pendingRef.current?.resolve(null);
    };
  }, []);

  if (!pending) return null;
  const finish = (path: string | null) => {
    pending.resolve(path);
    setPending(null);
  };
  return <ServerFolderPicker onSelect={(p) => finish(p)} onCancel={() => finish(null)} />;
}
