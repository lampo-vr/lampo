// What is said in the render on screen, in time: lines to read, the word being heard lit while it plays, a click on a
// word goes to its first frame (its timecode on hover), and words picked — selected like any text, or the line under
// the playhead — become a note that changes the words. "Since V…" shows what this version says differently. Heard once
// per render on the server (lib/transcripts.ts) and asked for only while this tab is open: nothing is heard otherwise.
import { Fragment, type MouseEvent, memo, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatRange } from '../../../lib/range.ts';
import { timecode } from '../../../lib/time.ts';
import { diffWords, engineName, lineOfWord, linesOfDiff, normWord, type WordOp, wordAt, wordsSpan } from '../../../lib/transcript.ts';
import { enc } from '../api/client.ts';
import { useInfo, useTranscript } from '../api/queries.ts';
import type { FrameRange, PlacedComment, Transcript, TranscriptAnswer } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { useScrollEdges } from '../lib/hooks.ts';
import { useTouch } from '../lib/media.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu, type MenuEntry, Tip } from '../ui/primitives.tsx';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { languageName } from './AutoCheck.tsx';
import { createFrameStore, type FrameStore } from './frameStore.ts';
import '../styles/transcript.css';

/** What the transcript tab shows: a search, and whether it compares with another version. */
export interface TranscriptFind {
  query: string;
  diff: boolean;
}
export const NO_FIND: TranscriptFind = { query: '', diff: false };

/** Words picked to change, where they are heard. */
export interface PickedWords {
  text: string;
  range: FrameRange;
}

const ready = (a: TranscriptAnswer | undefined): Transcript | null => (a?.state === 'ready' ? a.transcript : null);

/** The head's line in the transcript tab: the language heard and how many words. */
export function TranscriptMeta({ slug, v }: { slug: string; v: number }) {
  const a = useTranscript(slug, v).data;
  const tr = ready(a);
  if (!a || a.state === 'pending') return <SkLine w="7em" />;
  if (!tr) return null;
  return (
    <>
      {tr.language ? `${languageName(tr.language)} · ` : ''}
      {t('{n} word|{n} words', { n: tr.words.length })}
    </>
  );
}

/** Under the head: search what is said, and compare with another version. */
export function TranscriptTools({ find, setFind, v, base }: { find: TranscriptFind; setFind: (f: TranscriptFind) => void; v: number; base: number | null }) {
  return (
    <div className="tr-tools">
      <span className="tr-search">
        <I name="search" size={15} />
        <input
          className="input"
          type="search"
          value={find.query}
          onChange={(e) => setFind({ ...find, query: e.target.value })}
          placeholder={t('Search what is said')}
          aria-label={t('Search the transcript')}
          disabled={find.diff}
        />
      </span>
      {base !== null && (
        <button
          type="button"
          className={`btn sm ${find.diff ? 'on' : ''}`}
          aria-pressed={find.diff}
          onClick={() => setFind({ ...find, diff: !find.diff })}
          title={base < v ? t('What V{v} says differently from V{base}', { v, base }) : t('What V{base} says differently from V{v}', { v, base })}
          data-testid="transcript-diff-toggle"
        >
          <I name="compare" size={14} /> {base < v ? t('Since V{base}', { base }) : t('Against V{base}', { base })}
        </button>
      )}
    </div>
  );
}

export interface TranscriptViewProps {
  slug: string;
  v: number;
  fps: number;
  frame: number;
  /** The frame on screen while playing (frameStore.ts): the word heard lights up without rendering the list again. */
  live?: FrameStore;
  /** The version to compare with: the compare bar's other version, else the one before; null for the first. */
  base: number | null;
  find: TranscriptFind;
  onSeek: (frame: number) => void;
  onPlay: (range: FrameRange) => void;
  /** Absent: this person doesn't write notes. */
  onChangeWords?: (w: PickedWords) => void;
  /** Hear the render again (the Auto-check right): in a language picked because detection got it wrong, else detected. */
  onRerun?: (language?: string) => void;
  /** Notes that change the words, in this version's frames: their words are marked. */
  edits: PlacedComment[];
  composer: ReactNode;
  scroller: RefObject<HTMLDivElement | null>;
}

export function TranscriptView(p: TranscriptViewProps) {
  const answer = useTranscript(p.slug, p.v).data;
  const tr = ready(answer);
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const fallback = useMemo(() => createFrameStore(p.frame), [p.frame]);
  const live = p.live ?? fallback;
  // biome-ignore lint/correctness/useExhaustiveDependencies: words picked belong to the render they were picked in
  useEffect(() => setSel(null), [p.slug, p.v]);

  // The lines a search leaves, and its words lit.
  const { shown, hits } = useMemo(() => {
    const all = tr ? tr.lines.map((_, i) => i) : [];
    const tokens = p.find.query.split(/\s+/).map(normWord).filter(Boolean);
    if (!tr || !tokens.length) return { shown: all, hits: null };
    const said = tr.words.map((w) => normWord(w.text));
    const shown = all.filter((i) => {
      const l = tr.lines[i];
      const text = said.slice(l.w0, l.w0 + l.n).join(' ');
      return tokens.every((x) => text.includes(x));
    });
    const hits = new Set<number>();
    for (const i of shown) for (let w = tr.lines[i].w0; w < tr.lines[i].w0 + tr.lines[i].n; w++) if (tokens.some((x) => said[w].includes(x))) hits.add(w);
    return { shown, hits };
  }, [tr, p.find.query]);

  // Words a note already asks to change: marked, its id and the words asked for on hover.
  const marks = useMemo(() => {
    const m = new Map<number, string>();
    if (!tr) return m;
    for (const c of p.edits) {
      const r = c.rangeHere ?? { in: c.frameHere, out: c.frameHere };
      if (!c.text_edit || (c.status !== 'open' && c.status !== 'fixed')) continue;
      tr.words.forEach((w, i) => {
        if (w.f0 <= r.out && w.f1 >= r.in) m.set(i, `${c.id} → “${c.text_edit?.to}”`);
      });
    }
    return m;
  }, [tr, p.edits]);

  // Playing: the word heard lights up, its line comes into view — unless you are reading or picking elsewhere.
  const composing = !!p.composer;
  const listed = shown.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lit word is found again whenever other lines are listed
  useEffect(() => {
    const root = box.current;
    const sc = p.scroller.current;
    if (!tr || !root || p.find.diff) return;
    let word = -2;
    let line = -2;
    let userAt = 0;
    const touched = () => {
      userAt = Date.now();
    };
    sc?.addEventListener('wheel', touched, { passive: true });
    sc?.addEventListener('touchmove', touched, { passive: true });
    // an attribute React doesn't own: a class would be lost when React sets the word's className (a search, a pick)
    const lit = (attr: string, i: number, mark: string) => {
      for (const el of root.querySelectorAll(`[${mark}]`)) el.removeAttribute(mark);
      const el = i >= 0 ? root.querySelector(`[${attr}="${i}"]`) : null;
      el?.setAttribute(mark, '');
      return el;
    };
    const paint = () => {
      const f = live.get();
      const i = wordAt(tr, f);
      const heard = i >= 0 && f <= tr.words[i].f1 ? i : -1;
      const li = i >= 0 ? lineOfWord(tr, i) : -1;
      const inLine = li >= 0 && f <= tr.lines[li].f1 ? li : -1;
      if (heard !== word) {
        word = heard;
        lit('data-w', heard, 'data-now');
      }
      if (inLine === line) return;
      line = inLine;
      const el = lit('data-l', inLine, 'data-here');
      if (!el || !sc || composing || Date.now() - userAt < 2500 || !document.getSelection()?.isCollapsed) return;
      const a = el.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      if (a.top >= b.top && a.bottom <= b.bottom - 64) return;
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      sc.scrollTo({ top: sc.scrollTop + a.top - b.top - b.height / 3, behavior: smooth ? 'smooth' : 'auto' });
    };
    paint();
    const off = live.subscribe(paint);
    return () => {
      off();
      sc?.removeEventListener('wheel', touched);
      sc?.removeEventListener('touchmove', touched);
    };
  }, [tr, live, listed, composing, p.find.diff]);

  // Picking words: the browser's own selection (drag, double-click, shift-click, a long press), read as whole words.
  useEffect(() => {
    if (!tr) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const s = document.getSelection();
      const root = box.current;
      if (!s?.rangeCount || !root) return;
      const r = s.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return;
      if (s.isCollapsed) return setSel(null);
      let a = -1;
      let b = -1;
      for (const el of root.querySelectorAll<HTMLElement>('[data-w]'))
        if (covers(r, el)) {
          const i = Number(el.dataset.w);
          if (a < 0) a = i;
          b = i;
        }
      setSel((old) => (a < 0 ? null : old && old[0] === a && old[1] === b ? old : [a, b]));
    };
    const changed = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    document.addEventListener('selectionchange', changed);
    return () => {
      document.removeEventListener('selectionchange', changed);
      cancelAnimationFrame(raf);
    };
  }, [tr]);

  // A timecode goes to its line; a word (clicked, not dragged over) to the frame it starts on.
  const onClick = (e: MouseEvent) => {
    const el = e.target as Element;
    const tc = el.closest<HTMLElement>('.tr-tc[data-f]');
    if (tc) return p.onSeek(Number(tc.dataset.f));
    const w = el.closest<HTMLElement>('[data-w]');
    if (!w || !tr || !document.getSelection()?.isCollapsed) return;
    setSel(null);
    p.onSeek(tr.words[Number(w.dataset.w)].f0);
  };
  const clear = () => {
    document.getSelection()?.removeAllRanges();
    setSel(null);
  };
  const change = (w: PickedWords) => {
    clear();
    p.onChangeWords?.(w);
  };
  // the actions on a line: where your eye is, not at the panel's foot
  const { onPlay, onChangeWords } = p;
  const lineActs = useMemo<LineActs>(() => ({ play: (r) => onPlay(r), change: (w) => onChangeWords?.(w) }), [onPlay, onChangeWords]);

  let body: ReactNode;
  if (!answer || answer.state === 'pending') body = <TranscriptPending v={p.v} waiting={answer?.state === 'pending'} />;
  else if (answer.state === 'off')
    body = (
      <EmptyState size="sm" className="side-empty" art="note" title={t('Speech-to-text is off')} testId="transcript-off">
        {t('Turn it on in Settings → Voice notes: each version is then heard once, and what is said shows here.')}
      </EmptyState>
    );
  else if (answer.state === 'failed')
    body = (
      <EmptyState
        size="sm"
        className="side-empty"
        art="error"
        title={t('This version couldn’t be heard')}
        action={
          p.onRerun && (
            <button type="button" className="btn sm" onClick={() => p.onRerun?.()}>
              <I name="refresh" size={14} /> {t('Try again')}
            </button>
          )
        }
      >
        {answer.error}
      </EmptyState>
    );
  else if (tr && !tr.words.length)
    body = (
      <EmptyState size="sm" className="side-empty" art="clear" title={t('Nothing is said in this version')} testId="transcript-silent">
        {t('No voice-over or dialogue was heard.')}
      </EmptyState>
    );
  else if (tr && p.find.diff && p.base !== null) body = <TranscriptDiff slug={p.slug} tr={tr} v={p.v} base={p.base} fps={p.fps} />;
  else if (tr && !shown.length)
    body = (
      <EmptyState size="sm" className="side-empty" art="search" title={t('No line says “{query}”', { query: p.find.query.trim() })}>
        {t('Words are found without case and punctuation.')}
      </EmptyState>
    );
  else if (tr)
    body = <Lines tr={tr} fps={p.fps} shown={shown} hits={hits} marks={marks} sel={sel} acts={p.onChangeWords && !composing && !sel ? lineActs : null} />;
  // more lines below the bar: a soft fade over the last ones (none at the end) — the panel's scroller, its edges measured
  const [edgesRef, edges] = useScrollEdges<HTMLDivElement>('y');
  const { scroller } = p;
  const scrollerRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      edgesRef(el);
    },
    [scroller, edgesRef],
  );
  const words = !!tr?.words.length && !p.find.diff;
  return (
    <div className={`side-scroll tr-scroll ${edges}`} ref={scrollerRef} data-testid="transcript">
      {p.composer}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click on a word is a mouse shortcut; every line's timecode is a button */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div className="tr-body" ref={box} onClick={onClick}>
        {body}
        {tr && words && p.onChangeWords && !composing && sel && (
          <SelectionBar tr={tr} fps={p.fps} sel={sel} box={box} onClear={clear} onPlay={p.onPlay} onChange={change} />
        )}
      </div>
      {tr && words && <TranscriptFoot tr={tr} slug={p.slug} v={p.v} onRerun={p.onRerun} />}
    </div>
  );
}

/** Whether a selection takes in a word: a selection that only touches its edge (a double-click's trailing space) doesn't. */
function covers(r: Range, el: Element): boolean {
  if (!r.intersectsNode(el)) return false;
  const text = el.firstChild;
  const len = text?.textContent?.length ?? 0;
  if ((r.endContainer === text || r.endContainer === el) && r.endOffset === 0) return false;
  if (r.startContainer === text && r.startOffset >= len) return false;
  if (r.startContainer === el && r.startOffset >= el.childNodes.length) return false;
  return true;
}

// The lines, rendered again only when what they show changes (search, marks, a pick) — never per frame.
const Lines = memo(function Lines({
  tr,
  fps,
  shown,
  hits,
  marks,
  sel,
  acts,
}: {
  tr: Transcript;
  fps: number;
  shown: number[];
  hits: Set<number> | null;
  marks: Map<number, string>;
  sel: [number, number] | null;
  /** Play and Change on each line (shown on the line you are at or point at); null while picking or writing. */
  acts: LineActs | null;
}) {
  useLang(); // memo'd: renders again on a language switch by itself
  return (
    <div className="tr-lines">
      {shown.map((li) => {
        const l = tr.lines[li];
        const tc = timecode(l.f0, fps);
        return (
          <p key={li} className="tr-line" data-l={li}>
            <button type="button" className="tr-tc" data-f={l.f0} aria-label={t('Go to {timecode}', { timecode: tc })}>
              {tc}
            </button>
            <span className="tr-words">
              {tr.words.slice(l.w0, l.w0 + l.n).map((w, k) => {
                const i = l.w0 + k;
                const mark = marks.get(i);
                const cls = [hits?.has(i) && 'tr-hit', mark && 'tr-ed', sel && i >= sel[0] && i <= sel[1] && 'tr-sel'].filter(Boolean).join(' ');
                return (
                  <Fragment key={i}>
                    {k > 0 && ' '}
                    <span data-w={i} className={cls || undefined} title={`${timecode(w.f0, fps)} · f${w.f0}${mark ? ` · ${mark}` : ''}`}>
                      {w.text}
                    </span>
                  </Fragment>
                );
              })}
            </span>
            {acts && (
              <span className="tr-line-acts">
                <IconButton
                  className="btn ghost sm icon-only"
                  icon="play"
                  size={13}
                  label={t('Play this line')}
                  onClick={() => acts.play({ in: l.f0, out: l.f1 })}
                  data-testid="line-play"
                />
                <IconButton
                  className="btn ghost sm icon-only"
                  icon="edit"
                  size={13}
                  label={t('Change the words')}
                  onClick={() => acts.change({ text: l.text, range: { in: l.f0, out: l.f1 } })}
                  data-testid="line-change"
                />
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
});

/** While the render is heard (or the answer is on its way): the lines' own layout, waiting. */
function TranscriptPending({ v, waiting }: { v: number; waiting: boolean }) {
  return (
    <SkeletonRegion label={t('Loading what is said')}>
      {waiting && (
        <p className="tr-status" data-testid="transcript-pending">
          <Spinner /> {t('Listening to V{v}… the first time takes a moment.', { v })}
        </p>
      )}
      <div className="tr-lines">
        {['92%', '64%', '81%', '48%', '74%', '58%'].map((w) => (
          <p key={w} className="tr-line">
            <span className="tr-tc">
              <SkLine w="8ch" />
            </span>
            <span className="tr-words">
              <SkLine w={w} />
            </span>
          </p>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Runs of the same kind of change, for reading. */
const runsOf = (ops: WordOp[]) => {
  const out: { op: WordOp['op']; text: string; key: string }[] = [];
  for (const o of ops) {
    const last = out.at(-1);
    if (last?.op === o.op) last.text += ` ${o.w.text}`;
    else out.push({ op: o.op, text: o.w.text, key: `${o.op}${o.i}` });
  }
  return out;
};

/** What this version says differently from `base`: only the lines that changed, words struck and added. */
function TranscriptDiff({ slug, tr, v, base, fps }: { slug: string; tr: Transcript; v: number; base: number; fps: number }) {
  const a = useTranscript(slug, base).data;
  const old = ready(a);
  const changed = useMemo(() => (old ? linesOfDiff(tr, diffWords(old, tr)).filter((g) => g.ops.some((o) => o.op !== 'same')) : null), [old, tr]);
  if (!a || a.state === 'pending') return <TranscriptPending v={base} waiting={a?.state === 'pending'} />;
  if (!changed)
    return (
      <EmptyState size="sm" className="side-empty" art="error" title={t('V{base} can’t be compared', { base })}>
        {a.state === 'failed' ? a.error : t('Speech-to-text is off.')}
      </EmptyState>
    );
  if (!changed.length)
    return (
      <EmptyState size="sm" className="side-empty" art="check" title={t('Same words as V{base}', { base })} testId="transcript-same">
        {t('V{v} says what V{base} said, word for word.', { v, base })}
      </EmptyState>
    );
  return (
    <div className="tr-lines tr-diff" data-testid="transcript-diff">
      <p className="tr-status">
        {t('{n} line says something different from V{base}|{n} lines say something different from V{base}', { n: changed.length, base })}
      </p>
      {changed.map(({ line, ops }) => {
        const tc = line ? timecode(line.f0, fps) : '';
        return (
          <p key={line ? line.w0 : 'gone'} className="tr-line">
            {line ? (
              <button type="button" className="tr-tc" data-f={line.f0} aria-label={t('Go to {timecode}', { timecode: tc })}>
                {tc}
              </button>
            ) : (
              <span className="tr-tc" />
            )}
            <span className="tr-words">
              {runsOf(ops).map((r, j) => (
                <Fragment key={r.key}>
                  {j > 0 && ' '}
                  {r.op === 'same' ? (
                    <span>{r.text}</span>
                  ) : r.op === 'del' ? (
                    <del title={t('Said in V{base}', { base })}>{r.text}</del>
                  ) : (
                    <ins title={t('New in V{v}', { v })}>{r.text}</ins>
                  )}
                </Fragment>
              ))}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/** Languages offered for hearing it again: what was heard first, then the server's, then the ones most asked for. */
const COMMON = ['en', 'de', 'sv', 'es', 'fr', 'it', 'nl', 'da', 'no', 'fi', 'pl', 'pt', 'tr', 'ja'];
const offered = (heard: string, server: string[] = []): string[] => [...new Set([heard, ...server, ...COMMON].map((l) => l.toLowerCase()).filter(Boolean))];

// A download from a menu item: an <a download> the item clicks for you (menus hold buttons, not links).
const download = (href: string) => {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
};

/** Under the lines: what heard it and in which language, captions to download, hearing it again (in another language). */
function TranscriptFoot({ tr, slug, v, onRerun }: { tr: Transcript; slug: string; v: number; onRerun?: (language?: string) => void }) {
  const info = useInfo();
  const touch = useTouch();
  const file = (ext: string) => `/api/review/${enc(slug)}/transcript.${ext}?v=${v}`;
  const engine = engineName(tr.engine);
  const languages: MenuEntry[] = onRerun
    ? offered(tr.language, info?.stt?.languages).map((l) => ({
        label: l === tr.language ? t('{language} (heard)', { language: languageName(l) }) : languageName(l),
        onClick: () => onRerun(l),
      }))
    : [];
  return (
    <div className="tr-foot" data-testid="transcript-foot">
      <p className="tr-heard">
        <span data-testid="transcript-heard">
          {tr.language ? t('Heard in {language} · {engine}', { language: languageName(tr.language), engine }) : t('Heard by {engine}', { engine })}
        </span>
        {tr.timing === 'line' && (
          <Tip content={t('Word times are estimated: this engine times whole lines, not single words.')}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users reach its tooltip */}
            <span className="tr-heard-info" tabIndex={0} role="img" aria-label={t('Word times are estimated')} data-tip="">
              <I name="info" size={13} />
            </span>
          </Tip>
        )}
      </p>
      <div className="tr-actions">
        <Menu
          align="start"
          side="top"
          trigger={
            <button type="button" className="btn sm" data-testid="transcript-captions">
              <I name="download" size={14} /> {t('Download captions')} <I name="down" size={12} />
            </button>
          }
          items={[
            { label: t('SRT (most editors)'), icon: 'download', onClick: () => download(file('srt')) },
            { label: t('WebVTT (web players)'), icon: 'download', onClick: () => download(file('vtt')) },
          ]}
        />
        <span className="grow" />
        {onRerun && (
          <span className="tr-again">
            <button type="button" className="btn sm" onClick={() => onRerun()} data-testid="transcript-rerun">
              <I name="refresh" size={14} /> {t('Listen again')}
            </button>
            <Menu
              align="end"
              side="top"
              trigger={
                <IconButton
                  className="btn sm icon-only"
                  icon="down"
                  size={12}
                  label={t('Listen again in another language')}
                  data-testid="transcript-rerun-language"
                />
              }
              items={languages}
            />
          </span>
        )}
      </div>
      <p className="tr-hint">
        {touch ? t('Tap a word to go there; press and hold to pick words.') : t('Click a word to go there; select words to change them.')}
      </p>
    </div>
  );
}

// Keeps the selection while a button is pressed (a mouse-down elsewhere would clear it before the click).
const keep = (e: MouseEvent) => e.preventDefault();

interface LineActs {
  play: (r: FrameRange) => void;
  change: (w: PickedWords) => void;
}

/**
 * Words picked: a small bar right above them (below, where there is no room above) — play them, change them, or let
 * go. What and where are said to screen readers and in its tooltip; on screen the words are lit where they are.
 */
function SelectionBar({
  tr,
  fps,
  sel,
  box,
  onClear,
  onPlay,
  onChange,
}: {
  tr: Transcript;
  fps: number;
  sel: [number, number];
  box: RefObject<HTMLDivElement | null>;
  onClear: () => void;
  onPlay: (r: FrameRange) => void;
  onChange: (w: PickedWords) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const root = box.current;
    const el = bar.current;
    const a = root?.querySelector(`[data-w="${sel[0]}"]`)?.getBoundingClientRect();
    const b = root?.querySelector(`[data-w="${sel[1]}"]`)?.getBoundingClientRect();
    if (!root || !el || !a || !b) return;
    const r = root.getBoundingClientRect();
    const view = root.closest('.tr-scroll')?.getBoundingClientRect();
    const gap = 6;
    let top = a.top - r.top - el.offsetHeight - gap;
    if (view && a.top - el.offsetHeight - gap < view.top) top = b.bottom - r.top + gap;
    const left = Math.max(0, Math.min(a.left - r.left - 4, r.width - el.offsetWidth));
    setPos({ top, left });
  }, [sel, box]);
  const pick = wordsSpan(tr, sel[0], sel[1]);
  if (!pick) return null;
  const at = formatRange(pick.range, fps);
  return (
    <div
      ref={bar}
      className="tr-float"
      role="toolbar"
      aria-label={t('Selected words')}
      title={at}
      style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
      onMouseDown={keep}
      data-testid="transcript-pick"
    >
      <span className="sr-only">
        <span className="tr-pick-label">{t('Selected')}</span> <q className="tr-pick-words">{pick.text}</q> <span className="tr-pick-at">{at}</span>
      </span>
      <IconButton
        className="btn sm ghost icon-only"
        icon="play"
        size={14}
        label={t('Play the selected words')}
        onClick={() => onPlay(pick.range)}
        data-testid="transcript-pick-play"
      />
      <button type="button" className="btn sm primary" onClick={() => onChange(pick)} data-testid="change-words-button">
        <I name="edit" size={14} /> {t('Change the words')}
      </button>
      <IconButton
        className="btn sm ghost icon-only tr-pick-clear"
        icon="x"
        size={14}
        label={t('Clear the selection')}
        onClick={onClear}
        data-testid="transcript-pick-clear"
      />
    </div>
  );
}
