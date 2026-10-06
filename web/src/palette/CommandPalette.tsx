// The command palette: type to find any video, folder or note (GET /api/search: accents and German spelling folded,
// every word must match) or an action (go somewhere, change the library's layout, the theme, add a video). Arrow keys
// and Enter; ⌘/Ctrl-Enter opens a video in a new tab. Without a query: where to go, then the videos you opened last
// (Recent, the sidebar's list: lib/recent.ts), then the ones that changed lately.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SearchResponse } from '../../../lib/types.ts';
import { useAuthStatus, useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { keys, useInfo, useLibrary } from '../api/queries.ts';
import { crumbs } from '../lib/folders.ts';
import { ago } from '../lib/format.ts';
import { parseRoute } from '../lib/nav.ts';
import { posterUrl } from '../lib/posterUrl.ts';
import { storePref } from '../lib/prefs.ts';
import { RECENT_SHOWN, useRecent } from '../lib/recent.ts';
import { fold, marks } from '../lib/text.ts';
import { type Layout, LIBRARY_PREFS } from '../library/model.ts';
import { Badge } from '../ui/Badge.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { EmptyState } from '../ui/system.tsx';
import { useChooseTheme } from '../ui/ThemeSwitch.tsx';
import '../styles/palette.css';
import { t } from '../i18n/index.ts';
import { T, useLang } from '../i18n/T.tsx';
import { stageLabel } from '../status/stageText.ts';

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon?: IconName;
  thumb?: string;
  badge?: ReactNode;
  /** Extra words an action is found by. */
  keywords?: string;
  /** `newTab`: ⌘/Ctrl held. */
  run: (newTab: boolean) => void;
}

const goHash = (hash: string, newTab = false) => {
  if (newTab) window.open(`${location.pathname}${hash}`, '_blank', 'noopener');
  else location.hash = hash;
};

/** The text with the query's words marked (accent- and case-insensitive, like the search). */
function Marked({ text, words }: { text: string; words: string[] }) {
  const ranges = marks(text, words);
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) out.push(text.slice(at, from));
    out.push(<mark key={from}>{text.slice(from, to)}</mark>);
    at = to;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const term = useDebounced(q.trim(), 120);
  const can = useCan();
  const info = useInfo();
  // At the machine the app runs on a render is linked where it lives; anyone else uploads (like the library's button).
  const upload = !(useAuthStatus().data?.via === 'local' && info?.capabilities?.linkFiles);
  const chooseTheme = useChooseTheme();
  const lang = useLang();
  // The videos opened last, named from the library this app already holds (no request of their own).
  const openedSlugs = useRecent();
  const library = useLibrary(false).data;
  const { data, isFetching } = useQuery({
    queryKey: keys.search(term),
    queryFn: () => api<SearchResponse>(`/api/search?q=${enc(term)}&limit=6`),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  // Actions and marks follow every keystroke; server results only once they answer what is typed now, so Enter never
  // opens something from the previous query.
  const live = q.trim();
  const words = useMemo(() => fold(live).split(/\s+/).filter(Boolean), [live]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the actions' words follow the language (and so do the items, made from them)
  const actions = useMemo((): Item[] => {
    const layout = (l: Layout, label: string, icon: IconName): Item => ({
      id: `layout:${l}`,
      group: t('Library'),
      label,
      icon,
      keywords: 'layout view library',
      run: () => {
        storePref(LIBRARY_PREFS, 'layout', l);
        // Stay in the library view you are in; from anywhere else (or Insights and the inbox, which show no videos) go to all videos.
        const r = parseRoute(location.hash, location.pathname);
        if (r.name !== 'library' || r.view.kind === 'insights' || r.view.kind === 'inbox') location.hash = '#/';
      },
    });
    const list: (Item | false)[] = [
      can('upload') && {
        id: 'add',
        group: t('Actions'),
        label: upload ? t('Upload a video') : t('Add a video'),
        icon: upload ? 'upload' : 'plus',
        keywords: 'new render import',
        run: () => goHash('#/?add'),
      },
      {
        id: 'go:inbox',
        group: t('Go to'),
        label: t('Inbox'),
        icon: 'bell',
        keywords: 'for you waiting questions fixes verify review new renders',
        run: (t) => goHash('#/inbox', t),
      },
      { id: 'go:library', group: t('Go to'), label: t('All videos'), icon: 'film', keywords: 'library dailies home', run: (t) => goHash('#/', t) },
      { id: 'go:insights', group: t('Go to'), label: t('Insights'), icon: 'chart', keywords: 'stats', run: (t) => goHash('#/insights', t) },
      {
        id: 'go:settings',
        group: t('Go to'),
        label: t('Settings'),
        icon: 'settings',
        keywords: 'profile account password tokens users appearance speech voice auto-check agents mcp about',
        run: (t) => goHash('#/settings', t),
      },
      {
        id: 'go:playbook',
        group: t('Go to'),
        label: t('House playbook'),
        icon: 'playbook',
        keywords: 'playbook rules brief skills references house',
        run: (t) => goHash('#/settings/playbook', t),
      },
      layout('board', t('Show as board'), 'board'),
      layout('grid', t('Show as grid'), 'grid'),
      layout('compact', t('Show compact'), 'compact'),
      layout('list', t('Show as list'), 'list'),
      { id: 'theme:light', group: t('Theme'), label: t('Light theme'), icon: 'sun', keywords: 'appearance', run: () => chooseTheme('light') },
      { id: 'theme:dark', group: t('Theme'), label: t('Dark theme'), icon: 'moon', keywords: 'appearance', run: () => chooseTheme('dark') },
      {
        id: 'theme:system',
        group: t('Theme'),
        label: t('Theme like the system'),
        icon: 'system',
        keywords: 'appearance auto',
        run: () => chooseTheme('system'),
      },
    ];
    return list.filter((x): x is Item => !!x);
  }, [can, upload, chooseTheme, lang]);

  const items = useMemo((): Item[] => {
    const found = (it: Item) => !words.length || words.every((w) => fold(`${it.label} ${it.keywords ?? ''}`).includes(w));
    const bySlug = new Map((library?.videos ?? []).map((v) => [v.slug, v]));
    const opened: Item[] = words.length
      ? []
      : openedSlugs
          .map((s) => bySlug.get(s))
          .filter((v) => !!v && !v.archived)
          .slice(0, RECENT_SHOWN)
          .map((v) => {
            const s = v as NonNullable<typeof v>;
            return {
              id: `v:${s.slug}`,
              group: t('Recent'),
              label: s.name,
              sub: [s.folder ? crumbs(s.folder) : t('No project'), `V${s.v}`, s.updated ? ago(s.updated) : ''].filter(Boolean).join(' · '),
              thumb: s.hash ? posterUrl(s) : undefined,
              badge: (
                <Badge stage={s.stage.stage} size="sm">
                  {stageLabel(s.stage.stage)}
                </Badge>
              ),
              run: (t: boolean) => goHash(`#/v/${enc(s.slug)}`, t),
            };
          });
    const shown = new Set(opened.map((o) => o.id));
    const videos: Item[] = (data?.videos ?? []).map((v) => ({
      id: `v:${v.slug}`,
      group: term ? t('Videos') : t('Recently changed'),
      label: v.name,
      sub: [v.folder ? crumbs(v.folder) : t('No project'), `V${v.v}`, v.updated ? ago(v.updated) : ''].filter(Boolean).join(' · '),
      thumb: v.poster,
      badge: (
        <Badge stage={v.stage} size="sm">
          {stageLabel(v.stage)}
        </Badge>
      ),
      run: (t) => goHash(`#/v/${enc(v.slug)}`, t),
    }));
    const folders: Item[] = (data?.folders ?? []).map((f) => ({
      id: `f:${f.folder}`,
      group: t('Projects and folders'),
      label: f.name,
      sub: `${f.folder.includes('/') ? `${crumbs(f.folder)} · ` : ''}${t('{n} video|{n} videos', { n: f.videos })}`,
      icon: 'folder',
      run: (t) => goHash(`#/folder/${enc(f.folder)}`, t),
    }));
    const notes: Item[] = (data?.notes ?? []).map((n) => ({
      id: `n:${n.id}`,
      group: t('Notes'),
      label: n.reply ?? n.text,
      sub: `${n.video} · ${n.timecode} · ${n.author.replace(/^(agent|guest):/, '')}${n.reply ? ` · ${t('reply')}` : ''}`,
      icon: n.kind === 'question' ? 'help' : 'notes',
      run: (t) => goHash(`#/v/${enc(n.slug)}?c=${enc(n.id)}`, t),
    }));
    const current = data?.q === live;
    const matches = current ? [...videos.filter((v) => !shown.has(v.id)), ...folders, ...notes] : [];
    // Nothing typed: where to go first (and adding a video), then the videos you opened last, those that changed
    // lately, then the rest; typed: the matches
    if (!words.length) {
      const first = (it: Item) => it.id === 'add' || it.id.startsWith('go:');
      return [...actions.filter(first), ...opened, ...matches, ...actions.filter((it) => !first(it))];
    }
    return [...matches, ...actions.filter(found)];
  }, [data, term, live, words, actions, openedSlugs, library]);

  // A new query starts at the top again.
  const [shownFor, setShownFor] = useState(`${live}|${data?.q}`);
  if (shownFor !== `${live}|${data?.q}`) {
    setShownFor(`${live}|${data?.q}`);
    setActive(0);
  }
  const clamp = (i: number) => (items.length ? (i + items.length) % items.length : 0);
  const moveTo = (i: number) => {
    setActive(i);
    listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const run = (it: Item | undefined, newTab: boolean) => {
    if (!it) return;
    onClose();
    it.run(newTab);
  };
  const groups: { name: string; items: { it: Item; i: number }[] }[] = [];
  items.forEach((it, i) => {
    const g = groups.at(-1);
    if (g?.name === it.group) g.items.push({ it, i });
    else groups.push({ name: it.group, items: [{ it, i }] });
  });
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="backdrop" />
        <Dialog.Content className="palette" aria-describedby={undefined} data-testid="palette">
          <Dialog.Title className="sr-only">{t('Search and commands')}</Dialog.Title>
          <div className="palette-input">
            <I name="search" size={17} />
            {/* The dialog focuses this input when it opens: it is the first thing in it. */}
            <input
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={items.length ? optionId(active) : undefined}
              aria-autocomplete="list"
              aria-label={t('Search videos, folders, notes and actions')}
              placeholder={t('Search videos, folders, notes, actions…')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  moveTo(clamp(active + (e.key === 'ArrowDown' ? 1 : -1)));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  run(items[active], e.metaKey || e.ctrlKey);
                } else if (e.key === 'Home' && !q) {
                  moveTo(0);
                } else if (e.key === 'End' && !q) {
                  moveTo(clamp(-1));
                }
              }}
            />
            {isFetching && <span className="spinner" aria-hidden="true" />}
          </div>
          <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label={t('Results')}>
            {groups.map((g) => (
              // biome-ignore lint/a11y/useSemanticElements: a group of listbox options (ARIA), not of form fields (<fieldset>)
              <div key={g.name} role="group" aria-labelledby={`${listId}-${g.name}`} className="palette-group">
                <div className="palette-group-name" id={`${listId}-${g.name}`}>
                  {g.name}
                </div>
                {g.items.map(({ it, i }) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the combobox input (aria-activedescendant)
                  <div
                    key={it.id}
                    id={optionId(i)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === active}
                    data-index={i}
                    className="palette-item"
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={(e) => run(it, e.metaKey || e.ctrlKey)}
                  >
                    {it.thumb ? (
                      <img className="palette-thumb" src={it.thumb} alt="" loading="lazy" />
                    ) : (
                      <span className="palette-icon">
                        <I name={it.icon ?? 'right'} size={15} />
                      </span>
                    )}
                    <span className="palette-text">
                      <span className="palette-label ellipsis">
                        <Marked text={it.label} words={words} />
                      </span>
                      {it.sub && <span className="palette-sub ellipsis">{it.sub}</span>}
                    </span>
                    {it.badge}
                  </div>
                ))}
              </div>
            ))}
            {!items.length && !isFetching && (
              <EmptyState art="search" size="sm" className="palette-empty" title={t('No results')}>
                {t('Nothing found for “{x}”.', { x: q.trim() })}
              </EmptyState>
            )}
          </div>
          <div className="palette-foot" aria-hidden="true">
            <span>
              <kbd className="kbd">↑</kbd>
              <kbd className="kbd">↓</kbd> {t('choose')}
            </span>
            <span>
              <kbd className="kbd">↵</kbd> {t('open')}
            </span>
            <span>
              <kbd className="kbd">⌘↵</kbd> {t('new tab')}
            </span>
            <span>
              <T k={'<0>Esc</0> close'} tags={[(c) => <kbd className="kbd">{c}</kbd>]} />
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
