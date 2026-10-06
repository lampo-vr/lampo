// The playbook as one document: the brief, the rules, the skills and the references, each written where it is read.
// Every section has the same anatomy — its keyframe (written here, only inherited, empty), its title, what it holds,
// then its content — and the same states: written (it reads as text; Edit turns it into its editor in place), empty (the
// writing starts right there: the brief's field, the rules' "Add a rule" line and starter rules one click each), and
// inherited (what the playbooks above say, folded under this one's own: the deeper one wins). An agent's suggestion
// for a section waits inside it, with its diff and Accept / Reject.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PLAYBOOK_LIMITS, scopeLabel, skillMarkdown } from '../../../lib/playbookText.ts';
import type { NoteRef, Playbook, PlaybookLayer, PlaybookProposal, PlaybookSection, PlaybookView, TasteSuggestion } from '../../../lib/types.ts';
import { ApiError, enc } from '../api/client.ts';
import { playbookHref, playbookKeys, playbookRefUrl, usePlaybookActions, useSkill } from '../api/playbooks.ts';
import { useLibrary } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { toast, toastError, toastUndo } from '../lib/toast.ts';
import { FramePicker } from '../refs/FramePicker.tsx';
import { AutoTextarea } from '../ui/controls.tsx';
import type { Shape } from '../ui/glyphs.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Menu } from '../ui/primitives.tsx';
import { Button } from '../ui/system.tsx';
import type { DraftSection } from './agentText.ts';
import { InlineText, Markdown } from './Markdown.tsx';
import { sectionWords } from './PlaybookShell.tsx';
import { Diff, ProposalCard } from './Proposal.tsx';
import { SkillDialog } from './SkillDialog.tsx';
import { briefOutline, ruleCount, ruleFromNotes, ruleItems, unusedStarters, withLines, withoutRule } from './starters.ts';

/** A playbook's name in the UI: "House" (translated) or the folder's path. */
export const label = (scope: string) => (scope ? scopeLabel(scope) : t('House'));
/** The folder's own name ("Reels" for Northwind/Reels). */
export const shortName = (scope: string) => (scope ? scope.split('/').pop() || scope : t('House'));
/** Who made a change, without the agent: prefix. */
export const who = (by: string | null | undefined) => (by ? by.replace(/^agent:/, '') : '');

/** What a section says now (a skill: its SKILL.md), the left side of a suggestion's diff. */
export function currentText(p: Playbook, section: PlaybookSection): string {
  if (section === 'brief' || section === 'rules') return p[section];
  const s = p.skills.find((x) => `skill:${x.name}` === section);
  return s ? skillMarkdown(s) : '';
}

/** What a playbook holds, in a few words: "brief · 12 rules · 3 skills". */
export function factsOf(x: { brief: string; rules: string; skills: unknown[]; refs: unknown[] }): string {
  const out: string[] = [];
  if (x.brief.trim()) out.push(t('brief'));
  const n = ruleCount(x.rules);
  if (n) out.push(t('{n} rule|{n} rules', { n }));
  if (x.skills.length) out.push(t('{n} skill|{n} skills', { n: x.skills.length }));
  if (x.refs.length) out.push(t('{n} reference|{n} references', { n: x.refs.length }));
  return out.join(' · ');
}

const shapeOf = (own: boolean, inherited: boolean): Shape => (own ? 'diamond' : inherited ? 'half' : 'outline');

/** Sections report what is typed and not saved yet; the pane beside shows it where it will go. */
export type OnDraft = (section: DraftSection, text: string | null) => void;

interface DocProps {
  view: PlaybookView;
  scope: string;
  edit: boolean;
  /** Suggestions waiting for this section. */
  waiting: PlaybookProposal[];
}

function Section({
  kind,
  title,
  shape,
  meta,
  actions,
  children,
}: {
  kind: 'brief' | 'rules' | 'skills' | 'refs';
  title: string;
  shape: Shape;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="pb-sec" data-kind={kind} data-testid={`pb-${kind}`} data-state={shape} aria-labelledby={id}>
      <header className="pb-sec-head">
        <KeyGlyph shape={shape} size={12} className="pb-sec-key" />
        <h2 id={id} className="pb-sec-title">
          {title}
        </h2>
        {meta && <span className="pb-sec-meta">{meta}</span>}
        {actions && <span className="pb-sec-acts">{actions}</span>}
      </header>
      <div className="pb-sec-body">{children}</div>
    </section>
  );
}

/** Suggestions an agent made for a section, waiting inside it. */
function Waiting({ list, playbook, scope }: { list: PlaybookProposal[]; playbook: Playbook; scope: string }) {
  return list.map((p) => (
    <div key={p.id} className="pb-suggest" id={`pb-suggest-${p.id}`} data-testid="pb-suggestion">
      <ProposalCard proposal={p} current={currentText(playbook, p.section)} scope={scope} />
    </div>
  ));
}

// ---------------------------------------------------------------- writing a text section in place

/**
 * A section's text in its editor, where the text was. `ghost`: the section is empty and the field is its content (no
 * foot until something is typed). Saving names the revision it was opened on: when someone changed the same section
 * since, the save is refused and both versions stand side by side — keep theirs, or save yours over it.
 */
function TextEditor({
  view,
  scope,
  section,
  seed,
  ghost,
  placeholder,
  onDone,
  onDraft,
}: {
  view: PlaybookView;
  scope: string;
  section: DraftSection;
  seed?: string;
  ghost?: boolean;
  placeholder: string;
  onDone: () => void;
  onDraft: OnDraft;
}) {
  const act = usePlaybookActions(scope);
  const qc = useQueryClient();
  const saved = view.playbook[section];
  // the revision it was opened on (a save made from it is refused when someone changed this section since)
  const [base] = useState(view.playbook.rev);
  const [text, setText] = useState(seed ?? saved);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ rev: number; said: string } | null>(null);
  const dirty = text !== saved;
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is typed, reported as it changes
  useEffect(() => onDraft(section, dirty ? text : null), [text, dirty]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on the way out
  useEffect(() => () => onDraft(section, null), []);

  const save = async (over?: number) => {
    if (!dirty) return onDone();
    setBusy(true);
    try {
      const out = await act.writeText(section, text, { message: message.trim() || undefined, base_rev: over ?? base });
      toast(out.rev ? t('Saved — agents read it from now on') : t('Nothing changed'), 'ok');
      setConflict(null);
      onDraft(section, null);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict({ rev: Number(e.details.rev) || view.playbook.rev, said: e.message });
        void qc.invalidateQueries({ queryKey: playbookKeys.one(scope) });
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setText(saved);
    setConflict(null);
    onDone();
  };
  // who changed it since: the newest revision of this section after the one it was opened on
  const theirs = conflict && view.playbook.history.filter((h) => h.section === section && h.rev > base).at(-1);
  const title = section === 'brief' ? t('Brief') : t('Rules');
  return (
    <div className={`pb-editor ${ghost && !dirty ? 'ghost' : ''}`} data-testid={`pb-editor-${section}`}>
      <AutoTextarea
        className="pb-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onSubmit={() => void save()}
        onCancel={cancel}
        rows={ghost ? 3 : 6}
        autoFocus={!ghost || seed !== undefined}
        aria-label={title}
        placeholder={placeholder}
        data-testid={`pb-text-${section}`}
      />
      {conflict ? (
        <div className="pb-conflict" role="alert" data-testid="pb-conflict">
          <p className="pb-conflict-say">
            <KeyGlyph shape="half" size={12} />
            <span>
              {theirs
                ? t('{name} changed {what} while you were writing (r{rev}). Theirs is saved, yours isn’t yet: this is what saving yours would change.', {
                    name: who(theirs.accepted_by || theirs.by),
                    what: sectionWords(section),
                    rev: theirs.rev,
                  })
                : conflict.said}
            </span>
          </p>
          <Diff before={saved || null} after={text} context={2} />
          <div className="pb-editor-foot">
            <span className="grow" />
            <Button variant="ghost" onClick={cancel} data-testid="pb-conflict-theirs">
              {t('Keep theirs')}
            </Button>
            <Button variant="primary" onClick={() => void save(view.playbook.rev)} disabled={busy} data-testid="pb-conflict-mine">
              {t('Save mine over it')}
            </Button>
          </div>
        </div>
      ) : (
        (!ghost || dirty) && (
          <div className="pb-editor-foot">
            <input
              className="input pb-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') cancel();
              }}
              placeholder={t('What changed (optional)')}
              aria-label={t('What changed')}
              maxLength={PLAYBOOK_LIMITS.message}
            />
            <Button variant="ghost" onClick={cancel}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty} data-keys="⌘↵" data-testid={`pb-save-${section}`}>
              {t('Save')}
            </Button>
          </div>
        )
      )}
    </div>
  );
}

/** What the playbooks above say for a text section: folded, one line each, the nearest first. */
function Inherited({ kind, layers }: { kind: DraftSection; layers: PlaybookLayer[] }) {
  if (!layers.length) return null;
  return (
    <div className="pb-inh">
      {layers.map((l) => {
        const n = ruleCount(l.rules);
        const peek =
          kind === 'rules'
            ? (ruleItems(l.rules) ?? []).map((r) => r.text).join(' · ')
            : l.brief
                .split('\n')
                .find((x) => x.trim())
                ?.replace(/[*_`#>]/g, '') || '';
        return (
          <details key={l.scope} className="pb-inh-layer" data-testid="pb-inherited">
            <summary>
              <KeyGlyph shape="diamond" size={10} className="pb-inh-key" />
              <span className="pb-inh-from">
                {kind === 'rules'
                  ? t('{n} rule from {name}|{n} rules from {name}', { n, name: label(l.scope) })
                  : t('Brief from {name}', { name: label(l.scope) })}
              </span>
              <span className="pb-inh-peek ellipsis">{peek}</span>
              <I name="down" size={14} className="pb-inh-chev" />
            </summary>
            <div className="pb-inh-body">
              <Markdown text={l[kind]} className="pb-md" />
              <a className="pb-inh-open" href={playbookHref(l.scope)}>
                <I name="playbook" size={13} />
                {t('Open the {name} playbook', { name: label(l.scope) })}
                <span className="mono">r{l.rev}</span>
              </a>
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the brief

export function BriefSection({ view, scope, edit, waiting, draft, onDraft }: DocProps & { draft?: string; onDraft: OnDraft }) {
  const own = view.playbook.brief;
  // nearest first: what the parent says matters more than what the House says
  const inherited = view.layers.filter((l) => l.brief.trim()).reverse();
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | undefined>();
  const writing = edit && (open || draft !== undefined || !own);
  return (
    <Section
      kind="brief"
      title={t('Brief')}
      shape={shapeOf(!!own, !!inherited.length)}
      meta={!own && inherited.length > 0 && t('from {name}', { name: label(inherited[0].scope) })}
      actions={
        edit &&
        own &&
        !writing && (
          <Button variant="ghost" size="sm" icon="edit" onClick={() => setOpen(true)} data-testid="pb-edit-brief">
            {t('Edit')}
          </Button>
        )
      }
    >
      <Waiting list={waiting} playbook={view.playbook} scope={scope} />
      {writing ? (
        <>
          <TextEditor
            key={seed === undefined ? 'own' : 'seed'}
            view={view}
            scope={scope}
            section="brief"
            seed={seed}
            ghost={!own && !open}
            placeholder={
              scope
                ? t('What’s true for {name} only: who it’s for, what it should feel like, where it runs.', { name: shortName(scope) })
                : t('Who you make it for, what it should feel like, where it runs — what every version here should know.')
            }
            onDraft={onDraft}
            onDone={() => {
              setOpen(false);
              setSeed(undefined);
            }}
          />
          {!own && draft === undefined && (
            <Button variant="link" className="pb-outline" onClick={() => setSeed(briefOutline())} data-testid="pb-brief-outline">
              {t('Start from an outline')}
            </Button>
          )}
        </>
      ) : own ? (
        <Markdown text={own} className="pb-md" />
      ) : (
        !inherited.length && <p className="pb-none">{t('Nothing written yet.')}</p>
      )}
      <Inherited kind="brief" layers={inherited} />
    </Section>
  );
}

// ---------------------------------------------------------------- the rules

/**
 * The rules one per line: each reads as a rule and comes out on its own (with Undo); a new one is a line and ↵. Empty,
 * the section offers starter rules — one click adds one, saved — and what the notes keep asking for starts a line
 * for a person to finish. The whole text is still a click away (Edit) for anything more than a list.
 */
export function RulesSection({ view, scope, edit, waiting, draft, onDraft, topic }: DocProps & { draft?: string; onDraft: OnDraft; topic?: string | null }) {
  const act = usePlaybookActions(scope);
  const qc = useQueryClient();
  const own = view.playbook.rules;
  const items = useMemo(() => ruleItems(own), [own]);
  const inherited = view.layers.filter((l) => l.rules.trim()).reverse();
  const unused = useMemo(() => unusedStarters(own, ...inherited.map((l) => l.rules)), [own, inherited]);
  const [open, setOpen] = useState(false);
  // Starter rules: offered to a playbook just begun that inherits no rules, else a click away. Decided once, when the
  // page first knows the person may edit (so adding the third rule doesn't make the list vanish under the pointer).
  const offered = useRef<boolean | null>(null);
  if (offered.current === null && edit) offered.current = ruleCount(own) < 3 && !inherited.length;
  const [chosen, setStarters] = useState<boolean | null>(null);
  const starters = chosen ?? offered.current ?? false;
  const [adding, setAdding] = useState<Set<string>>(() => new Set());
  const [line, setLine] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const writing = edit && (open || draft !== undefined);
  const asks = view.suggestions ?? [];

  // Changes go one after the other, each made on the rules as the last answer left them: a second click doesn't wait
  // for the first, and never overwrites it.
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const change = (make: (rules: string) => string, message: string): Promise<boolean> => {
    const run = async () => {
      const p = qc.getQueryData<PlaybookView>(playbookKeys.one(scope))?.playbook ?? view.playbook;
      const next = make(p.rules);
      if (next === p.rules) return true;
      await act.writeText('rules', next, { message: message.slice(0, PLAYBOOK_LIMITS.message), base_rev: p.rev });
      return true;
    };
    const done = chain.current.then(run).catch((e: unknown) => {
      // someone changed the rules since this page last heard: say so, and read them again
      toastError(e);
      void qc.invalidateQueries({ queryKey: playbookKeys.one(scope) });
      return false;
    });
    chain.current = done;
    return done;
  };
  const focusLine = (text: string) => {
    setLine(text);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      el.scrollIntoView({ block: 'nearest' });
    });
  };
  // Insights' "Make it a rule" arrives as ?rule=<topic>: the line starts with the notes' newest ask for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only, with what the page shows then
  useEffect(() => {
    if (!topic || !edit) return;
    focusLine(ruleFromNotes(asks.find((s) => s.tag === topic) ?? ({ tag: topic, count: 0, examples: [] } as unknown as TasteSuggestion)));
  }, []);

  const addLine = () => {
    const rule = line.trim();
    if (!rule) return;
    setLine('');
    void change((r) => withLines(r, [rule]), `+ ${rule}`).then((ok) => !ok && setLine(rule));
  };
  const addStarter = (s: { id: string; line: string }) => {
    setAdding((a) => new Set(a).add(s.id));
    void change((r) => (unusedStarters(r).some((x) => x.id === s.id) ? withLines(r, [s.line]) : r), `+ ${s.line}`).finally(() =>
      setAdding((a) => {
        const n = new Set(a);
        n.delete(s.id);
        return n;
      }),
    );
  };
  const addAll = () => {
    const lines = unused.map((s) => s.line);
    setAdding(new Set(unused.map((s) => s.id)));
    void change((r) => withLines(r, lines), t('+ {n} starter rule|+ {n} starter rules', { n: lines.length })).finally(() => setAdding(new Set()));
  };
  const remove = (text: string) =>
    void change((r) => {
      const it = ruleItems(r)?.find((x) => x.text === text);
      return it ? withoutRule(r, it) : r;
    }, `− ${text}`).then((ok) => ok && toastUndo(t('Rule taken out'), () => change((r) => withLines(r, [text]), `+ ${text}`)));

  const shown = unused.filter((s) => !adding.has(s.id));
  const count = ruleCount(own);
  return (
    <Section
      kind="rules"
      title={t('Rules')}
      shape={shapeOf(!!own, !!inherited.length)}
      meta={count > 0 ? count : !own && inherited.length > 0 && t('from {name}', { name: label(inherited[0].scope) })}
      actions={
        edit &&
        !writing && (
          <>
            {!starters && shown.length > 0 && count < 6 && (
              <Button variant="ghost" size="sm" icon="spark" onClick={() => setStarters(true)} data-testid="pb-starters-open">
                {t('Starter rules')}
              </Button>
            )}
            {own && (
              <Button variant="ghost" size="sm" icon="edit" onClick={() => setOpen(true)} data-testid="pb-edit-rules">
                {t('Edit')}
              </Button>
            )}
          </>
        )
      }
    >
      <Waiting list={waiting} playbook={view.playbook} scope={scope} />
      {writing ? (
        <TextEditor
          view={view}
          scope={scope}
          section="rules"
          placeholder={t('- Logo bottom right, at most 8 % of the height\n- Captions in Inter 600, never over faces\n- -14 LUFS, true peak -1 dBTP')}
          onDraft={onDraft}
          onDone={() => setOpen(false)}
        />
      ) : (
        <>
          {items ? (
            !!items.length && (
              <ul className="pb-rules">
                {items.map((r) => (
                  <li key={`${r.from}:${r.text}`} className="pb-rule" data-testid="pb-rule">
                    <KeyGlyph shape="diamond" size={8} className="pb-rule-key" />
                    <span className="pb-rule-text">
                      <InlineText text={r.text} />
                    </span>
                    {edit && (
                      <IconButton
                        className="btn ghost sm icon-only pb-rule-x"
                        label={t('Take this rule out')}
                        icon="x"
                        size={13}
                        onClick={() => remove(r.text)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <Markdown text={own} className="pb-md" />
          )}
          {edit && (
            <div className="pb-add">
              <KeyGlyph shape="outline" size={8} className="pb-rule-key" />
              <AutoTextarea
                ref={field}
                className="pb-add-field"
                value={line}
                rows={1}
                onChange={(e) => setLine(e.target.value.replace(/\n/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addLine();
                  }
                }}
                onCancel={() => {
                  setLine('');
                  field.current?.blur();
                }}
                placeholder={count || inherited.length ? t('Add a rule') : t('Add a rule: what every version here must do, or never do')}
                aria-label={t('Add a rule')}
                maxLength={PLAYBOOK_LIMITS.text}
                data-testid="pb-add-rule"
              />
              {line.trim() && (
                <Button size="sm" variant="primary" onClick={addLine} data-keys="↵" data-testid="pb-add-rule-save">
                  {t('Add')}
                </Button>
              )}
            </div>
          )}
          {!edit && !own && !inherited.length && <p className="pb-none">{t('Nothing written yet.')}</p>}
        </>
      )}
      {edit && !writing && asks.length > 0 && (
        <div className="pb-asks" data-testid="pb-taste">
          <span className="pb-asks-label">
            <I name="notes" size={14} />
            {t('The notes keep asking for')}
          </span>
          {asks.map((s) => (
            <button
              key={s.tag}
              type="button"
              className="pb-ask"
              onClick={() => focusLine(ruleFromNotes(s))}
              title={s.examples.map((x) => `${x.text} — ${x.video}`).join('\n')}
              data-testid="pb-make-rule"
            >
              <b>{s.tag}</b>
              <span className="mono">{t('{n}×', { n: s.count })}</span>
            </button>
          ))}
        </div>
      )}
      {edit && !writing && starters && shown.length > 0 && (
        <div className="pb-starters" data-testid="pb-starters">
          <div className="pb-starters-head">
            <I name="spark" size={14} />
            <span className="grow">{t('Starter rules — one click adds one')}</span>
            {shown.length > 1 && (
              <Button variant="link" onClick={addAll} data-testid="pb-starters-all">
                {t('Add all {n}', { n: shown.length })}
              </Button>
            )}
            <IconButton className="btn ghost sm icon-only" label={t('Hide the starter rules')} icon="x" size={13} onClick={() => setStarters(false)} />
          </div>
          <ul>
            {shown.map((s) => (
              <li key={s.id}>
                <button type="button" className="pb-starter" onClick={() => addStarter(s)} data-testid="pb-starter">
                  <I name="plus" size={14} />
                  <span>{s.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Inherited kind="rules" layers={inherited} />
    </Section>
  );
}

// ---------------------------------------------------------------- skills

export function SkillsSection({ view, scope, edit, waiting, onOpen }: DocProps & { onOpen: (name: string | null) => void }) {
  const own = view.skills.filter((s) => s.from === scope);
  const inherited = view.skills.filter((s) => s.from !== scope);
  // a skill of this playbook with the name of one above: this one is what agents get
  const overrides = (name: string) => view.layers.some((l) => l.skills.some((s) => s.name === name));
  return (
    <Section kind="skills" title={t('Skills')} shape={shapeOf(!!own.length, !!inherited.length)} meta={view.skills.length || null}>
      <Waiting list={waiting} playbook={view.playbook} scope={scope} />
      {(view.skills.length > 0 || edit) && (
        <ul className="pb-skills">
          {[...own, ...inherited].map((s) => (
            <li key={s.name}>
              <button type="button" className={`pb-skill-row ${s.from !== scope ? 'inherited' : ''}`} onClick={() => onOpen(s.name)} data-testid="pb-skill-row">
                <span className="pb-skill-icon" aria-hidden="true">
                  <I name="terminal" size={15} />
                </span>
                <span className="pb-skill-text">
                  <span className="pb-skill-name mono">{s.name}</span>
                  <span className="pb-skill-desc">{s.description}</span>
                </span>
                {!!s.files.length && (
                  <span className="pb-skill-chip" title={t('{n} file|{n} files', { n: s.files.length })}>
                    <I name="attach" size={12} />
                    {s.files.length}
                  </span>
                )}
                {s.from !== scope ? (
                  <span className="pb-skill-chip from">{label(s.from)}</span>
                ) : (
                  overrides(s.name) && <span className="pb-skill-chip from">{t('replaces the one above')}</span>
                )}
                <I name="right" size={14} className="pb-skill-go" />
              </button>
            </li>
          ))}
          {edit && (
            <li>
              <button type="button" className="pb-skill-row add" onClick={() => onOpen(null)} data-testid="pb-new-skill">
                <span className="pb-skill-icon" aria-hidden="true">
                  <I name="plus" size={15} />
                </span>
                <span className="pb-skill-text">
                  <span className="pb-skill-name">{t('New skill')}</span>
                  {!view.skills.length && (
                    <span className="pb-skill-desc">{t('How you export, name and grade — steps an agent follows the same way every time.')}</span>
                  )}
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
      {!edit && !view.skills.length && <p className="pb-none">{t('No skills yet.')}</p>}
    </Section>
  );
}

/** The skill dialog for a skill of this playbook, one it inherits (read-only, with its instructions) or a new one. */
export function OpenSkill({
  view,
  scope,
  name,
  edit,
  onClose,
}: {
  view: PlaybookView;
  scope: string;
  name: string | null;
  edit: boolean;
  onClose: () => void;
}) {
  const own = name ? view.playbook.skills.find((s) => s.name === name && view.skills.some((x) => x.name === s.name && x.from === scope)) : null;
  const merged = name ? view.skills.find((s) => s.name === name) : null;
  const inherited = merged && merged.from !== scope ? merged : null;
  const body = useSkill(scope, inherited ? inherited.name : null).data?.body;
  return (
    <SkillDialog
      scope={scope}
      skill={own ?? null}
      inherited={inherited ? { ...inherited, body } : null}
      base_rev={view.playbook.rev}
      canEdit={edit}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------- references

export function RefsSection({ view, scope, edit }: Omit<DocProps, 'waiting'>) {
  const act = usePlaybookActions(scope);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  const [picking, setPicking] = useState(false);
  const image = useRef<HTMLInputElement>(null);
  const lib = useLibrary();
  // a moment of a render starts from a video of this folder (any other is a search away in the picker)
  const first = useMemo(
    () => (lib.data?.videos || []).find((v) => !v.archived && (!scope || v.folder === scope || v.folder?.startsWith(`${scope}/`))),
    [lib.data, scope],
  );
  const own = view.playbook.refs;
  const inherited = view.layers.flatMap((l) => l.refs.map((r) => ({ r, from: l.scope })));
  const count = own.length + inherited.length;
  const addLink = async () => {
    try {
      await act.addLink(url.trim());
      setUrl('');
      setLinking(false);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Section kind="refs" title={t('References')} shape={shapeOf(!!own.length, !!inherited.length)} meta={count || null}>
      <input
        ref={image}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void act.addImage(f).catch(toastError);
        }}
        data-testid="pb-ref-image"
      />
      {linking && (
        <form
          className="pb-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void addLink();
          }}
        >
          <input
            className="input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            aria-label={t('Link')}
            autoFocus
            onKeyDown={(e) => e.key === 'Escape' && setLinking(false)}
            data-testid="pb-link-url"
          />
          <Button type="submit" size="sm" variant="primary" disabled={!url.trim()}>
            {t('Add')}
          </Button>
        </form>
      )}
      {(count > 0 || edit) && (
        <ul className="pb-refs">
          {own.map((r) => (
            <RefTile key={r.id} r={r} scope={scope} onRemove={edit ? () => void act.removeRef(r.id).catch(toastError) : undefined} />
          ))}
          {inherited.map(({ r, from }) => (
            <RefTile key={r.id} r={r} scope={from} from={from} />
          ))}
          {edit && (
            <li className="pb-ref add">
              <Menu
                trigger={
                  <button type="button" className="pb-ref-add" data-testid="pb-add-ref">
                    <I name="plus" size={16} />
                    <span>{t('Add a reference')}</span>
                  </button>
                }
                items={[
                  { label: t('A link'), icon: 'link', onClick: () => setLinking(true) },
                  { label: t('A picture…'), icon: 'image', onClick: () => image.current?.click() },
                  first && { label: t('A moment of a video…'), icon: 'film', onClick: () => setPicking(true) },
                ]}
              />
            </li>
          )}
        </ul>
      )}
      {!count && <p className="pb-none">{t('Pictures, links and moments of approved videos that show what “right” looks like.')}</p>}
      {picking && first && (
        <FramePicker
          slug={first.slug}
          name={first.name}
          onClose={() => setPicking(false)}
          onPick={(pr) => {
            if (pr.kind === 'frame') void act.addFrame(pr.video, pr.frame, pr.v, pr.caption || undefined).catch(toastError);
          }}
        />
      )}
    </Section>
  );
}

function RefTile({ r, scope, from, onRemove }: { r: NoteRef; scope: string; from?: string; onRemove?: () => void }) {
  const title = r.kind === 'link' ? r.site || r.url : r.kind === 'frame' ? `${r.name} · V${r.v} · ${r.timecode}` : r.caption || t('Picture');
  const body =
    r.kind === 'link' ? (
      <a className="pb-ref-link" href={r.url} target="_blank" rel="noreferrer noopener">
        <I name="link" size={14} />
        <span className="ellipsis">{title}</span>
      </a>
    ) : (
      <a
        className="pb-ref-pic"
        href={r.kind === 'frame' ? `#/v/${enc(r.video || '')}?v=${r.v}&f=${r.frame}` : playbookRefUrl(scope, r.file || '')}
        target={r.kind === 'frame' ? undefined : '_blank'}
        rel="noreferrer"
      >
        {r.still && <img src={playbookRefUrl(scope, r.still)} alt={r.caption || title} loading="lazy" />}
      </a>
    );
  return (
    <li className={`pb-ref ${r.kind}`} data-testid="pb-ref">
      {body}
      <div className="pb-ref-meta">
        <span className="ellipsis" title={r.kind === 'frame' ? title : undefined}>
          {r.kind === 'link' ? r.caption || r.url : r.caption || title}
        </span>
        {from !== undefined && <span className="muted">{label(from)}</span>}
        {onRemove && <IconButton className="btn ghost sm icon-only pb-ref-x" label={t('Remove reference')} icon="x" size={13} onClick={onRemove} />}
      </div>
    </li>
  );
}
