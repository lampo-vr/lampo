// Publishing a final version (docs/publishing.md): the composer, one post per platform — where it goes, the words, the
// cover on an exact frame, when, and the answers the platforms ask for (never preselected) — with each platform's limits
// beside the field they bound, the publish kit for posting by hand, and once published where the post stands. Agents
// draft posts too; only a person publishes, after a confirm that names the platform and the account. Its own chunk: the
// player asks for it when "Publish…" is chosen or the address says `?publish=` (lib/lazy.ts).
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { PLATFORM_LIMITS, PLATFORMS, YOUTUBE_CATEGORIES } from '../../../lib/publish/platforms.ts';
import { timecode } from '../../../lib/time.ts';
import type { ConnectionsResponse, KitFile, KitInfo, PostFields, PostProblem, PostState, PostView, PublishPlatform } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import { ApiError, enc } from '../api/client.ts';
import type { ReviewResponse } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { ago, bytes, fileName } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { type FrameStore, useFrame } from '../player/frameStore.ts';
import { Progress } from '../ui/controls.tsx';
import type { Shape } from '../ui/glyphs.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Switch } from '../ui/plain.tsx';
import { PlatformMark } from '../ui/platformMarks.tsx';
import { Modal, Segmented, useConfirm } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import { Chip } from '../ui/system.tsx';
import { useConnections, useKit, usePostActions, usePosts } from './api.ts';
import { againWords, draftedBy, PLATFORM_LABEL, problemText, stateWord, visibilityWord, wentOut, whenWords } from './words.ts';
import '../styles/publish.css';

/** A post's state as a keyframe glyph (never a coloured dot). */
export const POST_SHAPE: Record<PostState, Shape> = {
  draft: 'outline',
  queued: 'hold',
  uploading: 'half',
  scheduled: 'hold',
  posted: 'diamond',
  failed: 'diamond',
  cancelled: 'outline',
  sent: 'half',
};

/** Warnings a draft may carry that stop it once a person publishes (the server says `block` then). */
const NEEDED_TO_PUBLISH = new Set([
  'title_missing',
  'ai_missing',
  'kids_missing',
  'connection_missing',
  'connection_not_ready',
  'account_missing',
  'schedule_past',
]);
const blocking = (p: PostProblem) => p.level === 'block' || NEEDED_TO_PUBLISH.has(p.code);
const EDITABLE: PostState[] = ['draft', 'failed', 'cancelled'];

interface PublishingProps {
  data: ReviewResponse;
  /** A post's id to open on, or "1" for the first. */
  focus: string;
  /** The player's frame on screen. */
  live: FrameStore;
  onClose: () => void;
}

/** The composer, or — while a cover is being picked on the player — the bar that picks it. */
export default function Publishing({ data, focus, live, onClose }: PublishingProps) {
  const [picking, setPicking] = useState<PostView | null>(null);
  const [opened, setOpened] = useState<string>(focus);
  if (picking)
    return (
      <CoverPick
        data={data}
        post={picking}
        live={live}
        onDone={() => {
          setOpened(picking.id);
          setPicking(null);
        }}
      />
    );
  return <Composer data={data} focus={opened} live={live} onClose={onClose} onPickCover={setPicking} />;
}

/** "Choose the cover": the composer steps aside so the player can be scrubbed to the frame; one click takes it. */
function CoverPick({ data, post, live, onDone }: { data: ReviewResponse; post: PostView; live: FrameStore; onDone: () => void }) {
  const actions = usePostActions(data.slug);
  const frame = useFrame(live);
  const fps = data.review.versions.find((x) => x.v === post.v)?.fps ?? data.review.fps;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onDone]);
  return (
    <div className="pub-pick" role="toolbar" aria-label={t('Choose the cover')} data-testid="pub-cover-pick">
      <span className="pub-pick-text">
        <b>{t('Choose the cover')}</b>
        <span>{t('Go to the frame, then use it.')}</span>
      </span>
      <span className="mono pub-pick-tc">{timecode(frame, fps)}</span>
      <button type="button" className="btn sm ghost" onClick={onDone}>
        {t('Cancel')}
      </button>
      <button
        type="button"
        className="btn sm primary"
        data-testid="pub-cover-use"
        onClick={() => {
          actions.change(post.id, { cover_frame: live.get() }).catch(toastError);
          onDone();
        }}
      >
        <I name="check" size={14} /> {t('Use this frame')}
      </button>
    </div>
  );
}

function Composer({
  data,
  focus,
  live,
  onClose,
  onPickCover,
}: {
  data: ReviewResponse;
  focus: string;
  live: FrameStore;
  onClose: () => void;
  onPickCover: (p: PostView) => void;
}) {
  const slug = data.slug;
  const can = useCan();
  const posts = usePosts(slug).data?.posts;
  const conns = useConnections(can('post')).data;
  const actions = usePostActions(slug);
  const finalV = data.review.final?.v ?? null;
  const stage = data.summary.stage;
  const open = finalV !== null && stage.stage === 'final' && !stage.final_superseded;
  const mine = (posts ?? []).filter((p) => p.v === finalV);
  const earlier = (posts ?? []).filter((p) => p.v !== finalV);
  const [platform, setPlatform] = useState<PublishPlatform | null>(null);
  // where it opens: the post asked for, else the first one written, else YouTube
  const asked = posts?.find((p) => p.id === focus);
  const shown: PublishPlatform = platform ?? asked?.platform ?? mine[0]?.platform ?? 'youtube';
  const post = mine.find((p) => p.platform === shown) ?? null;
  const name = fileName(data.review.video);

  const start = (p: PublishPlatform) => {
    if (!open || !can('post') || mine.some((x) => x.platform === p) || actions.create.isPending) return;
    actions.create.mutate(p, { onError: toastError });
  };
  // picking a platform with no post yet starts its draft — once the posts are read, if they weren't yet
  const [startWhenRead, setStartWhenRead] = useState<PublishPlatform | null>(null);
  const pick = (p: PublishPlatform) => {
    setPlatform(p);
    if (posts) start(p);
    else setStartWhenRead(p);
  };
  useEffect(() => {
    if (!posts || !startWhenRead) return;
    setStartWhenRead(null);
    start(startWhenRead);
  });

  return (
    <Modal
      title={t('Publish {video}', { video: name })}
      onClose={onClose}
      width={880}
      head={finalV !== null ? <Chip kind="version">V{finalV}</Chip> : undefined}
    >
      <div className="pub" data-testid="publish">
        <div className="tabs pub-tabs" role="tablist" aria-label={t('Where it goes')}>
          {PLATFORMS.map((p) => {
            const it = mine.find((x) => x.platform === p);
            return (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === shown}
                className={p === shown ? 'on' : ''}
                onClick={() => pick(p)}
                data-testid={`pub-tab-${p}`}
              >
                <PlatformMark platform={p} size={15} />
                <span>{PLATFORM_LABEL[p]}</span>
                {it && (
                  <span className={`pub-tab-state s-${it.state}`}>
                    <KeyGlyph shape={POST_SHAPE[it.state]} size={7} />
                    <span className="pub-tab-word">{stateWord(it.state)}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!open && (
          <p className="pub-note" data-testid="pub-not-final">
            {stage.final_superseded
              ? t('V{v} arrived after the final V{final}: posts go out from a final version. Reopen it and mark the new version final first.', {
                  v: stage.final_superseded,
                  final: finalV ?? '',
                })
              : t('Posts go out from a final version: mark a version final first.')}
          </p>
        )}
        <div role="tabpanel" className="pub-panel" aria-label={PLATFORM_LABEL[shown]}>
          {!posts ? (
            <PanelPending />
          ) : !post ? (
            <Start platform={shown} canDraft={open && can('post')} busy={actions.create.isPending} onStart={() => start(shown)} />
          ) : EDITABLE.includes(post.state) && open ? (
            <PostForm key={post.id} data={data} post={post} conns={conns} live={live} actions={actions} onPickCover={() => onPickCover(post)} />
          ) : (
            <PostStatus post={post} actions={actions} hosted={!!conns?.hosted} />
          )}
        </div>
        {earlier.length > 0 && (
          <details className="pub-earlier">
            <summary>{t('Posts of earlier versions · {n}', { n: earlier.length })}</summary>
            <ul>
              {earlier.map((p) => (
                <li key={p.id}>
                  <PlatformMark platform={p.platform} size={13} />
                  <span>
                    V{p.v} · {PLATFORM_LABEL[p.platform]} · {stateWord(p.state)}
                  </span>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {t('Open')} <I name="external" size={12} />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

/** The panel's room while the posts load: the form's first lines, so nothing jumps when they arrive. */
function PanelPending() {
  return (
    <div className="pub-pending" aria-busy="true">
      <span className="sk-line" style={{ width: '40%' }} />
      <span className="sk-line" style={{ width: '90%' }} />
      <span className="sk-line" style={{ width: '70%' }} />
    </div>
  );
}

function Start({ platform, canDraft, busy, onStart }: { platform: PublishPlatform; canDraft: boolean; busy: boolean; onStart: () => void }) {
  return (
    <div className="pub-start" data-testid="pub-start">
      <span className="pub-start-mark">
        <PlatformMark platform={platform} size={28} />
      </span>
      <p>{t('No {platform} post for this version yet.', { platform: PLATFORM_LABEL[platform] })}</p>
      {canDraft && (
        <button type="button" className="btn primary" onClick={onStart} disabled={busy} data-testid="pub-start-button">
          <I name="edit" size={15} /> {t('Write the {platform} post', { platform: PLATFORM_LABEL[platform] })}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the form

/** A text kept here while typed and sent a moment later (or when the field is left); the server's value when untouched. */
function useTyped(server: string, commit: (v: string) => Promise<unknown> | undefined, delay = 600) {
  const [value, setValue] = useState(server);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(server);
  const sent = useRef(server);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!timer.current && server !== sent.current) {
      setValue(server);
      latest.current = server;
    }
    sent.current = server;
  }, [server]);
  const flush = (): Promise<unknown> | undefined => {
    if (!timer.current) return undefined;
    clearTimeout(timer.current);
    timer.current = null;
    sent.current = latest.current;
    return commitRef.current(latest.current);
  };
  const set = (v: string) => {
    setValue(v);
    latest.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  };
  // leaving the form (another platform, closing it) sends what was typed
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on leaving; flush reads refs
  useEffect(() => () => void flush(), []);
  return { value, set, flush };
}

const tagsText = (tags: string[]) => tags.join(', ');
const parseTags = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim().replace(/^#/, ''))
    .filter(Boolean);
/** ISO → what a datetime-local field shows (this browser's time). */
const localInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const tomorrowAt10 = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
};

type Actions = ReturnType<typeof usePostActions>;

function PostForm({
  data,
  post: p,
  conns,
  live,
  actions,
  onPickCover,
}: {
  data: ReviewResponse;
  post: PostView;
  conns: ConnectionsResponse | undefined;
  live: FrameStore;
  actions: Actions;
  onPickCover: () => void;
}) {
  const can = useCan();
  const L = PLATFORM_LIMITS[p.platform];
  const ver = data.review.versions.find((x) => x.v === p.v);
  const fps = ver?.fps ?? data.review.fps;
  const [saving, setSaving] = useState(0);
  const inflight = useRef(new Set<Promise<unknown>>());
  const [ask, confirmation] = useConfirm();
  const change = (f: PostFields): Promise<unknown> => {
    setSaving((n) => n + 1);
    const out = actions
      .change(p.id, f)
      .catch((e) => {
        toastError(e);
      })
      .finally(() => {
        inflight.current.delete(out);
        setSaving((n) => n - 1);
      });
    inflight.current.add(out);
    return out;
  };
  const title = useTyped(p.title, (v) => change({ title: v }));
  const description = useTyped(p.description, (v) => change({ description: v }));
  const tags = useTyped(tagsText(p.tags), (v) => change({ tags: parseTags(v) }));
  const flushAll = () => Promise.all([title.flush(), description.flush(), tags.flush()]);

  const byField = (f: string) => p.problems.filter((x) => x.field === f);
  const loose = p.problems.filter((x) => x.field === 'video' || x.field === 'final');
  const needs = p.problems.filter(blocking);
  const choices = (conns?.connections ?? []).filter((c) =>
    p.platform === 'youtube' ? c.kind === 'youtube' : c.kind === 'zernio' && (c.platforms.includes(p.platform) || !c.accounts.length),
  );
  const conn = choices.find((c) => c.id === p.connection) ?? null;
  const accounts = conn?.accounts.filter((a) => a.platform === p.platform) ?? [];
  const isYT = p.platform === 'youtube';
  const descLength = isYT ? new TextEncoder().encode(description.value).length : [...description.value].length;
  const tagList = parseTags(tags.value);
  const tagCount = isYT ? tagList.reduce((n, x) => n + [...x].length + (x.includes(' ') ? 2 : 0), 0) + Math.max(0, tagList.length - 1) : tagList.length;

  // Publish stays clickable while a field saves: leaving the field to click it sends what was typed, and this waits for it.
  const publish = async () => {
    await flushAll();
    await Promise.all([...inflight.current]);
    // What the person looks at now, after the fields' writes answered: its digest goes with the confirmation, so an edit
    // made since (an agent's, another tab's) is refused rather than published under this person's name (A12 PUB-3).
    const seen = actions.current(p.id) ?? p;
    // One that went out before is posted again only knowingly (A12 PUB-1): its own question first.
    const again = wentOut(seen);
    const accountName = accounts.find((a) => a.id === seen.account)?.name ?? seen.account_name ?? '';
    const when = seen.schedule_at ? t('goes live {when}', { when: whenWords(seen.schedule_at) }) : t('goes out now');
    const twice = again ? againWords(seen) : null;
    const yes = await ask({
      title: twice?.title ?? t('Publish to {platform} as {account}?', { platform: PLATFORM_LABEL[p.platform], account: accountName }),
      body: (
        <div className="pub-confirm" data-testid="pub-confirm">
          {twice && (
            <p className="pub-warn" data-testid="pub-again">
              {twice.body}
              {seen.url && (
                <>
                  {' '}
                  <a href={seen.url} target="_blank" rel="noreferrer">
                    {t('Open on {platform}', { platform: PLATFORM_LABEL[p.platform] })} <I name="external" size={12} />
                  </a>
                </>
              )}
            </p>
          )}
          {twice && <p>{t('as {account}', { account: accountName })}</p>}
          <p>
            {t('V{v} of {video} · {visibility} · {when}.', {
              v: p.v,
              video: fileName(data.review.video),
              visibility: visibilityWord(seen.visibility),
              when,
            })}
          </p>
          {isYT && conn && !conn.audited && (
            <p className="pub-warn">{t('YouTube keeps it private until your Google project passes YouTube’s audit: you make it public in YouTube Studio.')}</p>
          )}
          {seen.schedule_at && conn && !conn.holds_schedule && !conns?.hosted && (
            <p className="pub-warn">{t('Lampo sends it at that time: keep this machine awake and Lampo running then.')}</p>
          )}
        </div>
      ),
      action: twice?.action ?? t('Publish'),
    });
    if (!yes) return;
    try {
      await actions.publish.mutateAsync({
        id: p.id,
        confirm: { platform: seen.platform, account: seen.account, digest: seen.digest ?? '' },
        again,
      });
      toast(seen.schedule_at ? t('Published: it goes live {when}', { when: whenWords(seen.schedule_at) }) : t('Published: it is on its way'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!(await ask({ title: t('Delete the {platform} draft?', { platform: PLATFORM_LABEL[p.platform] }), action: t('Delete'), danger: true }))) return;
    try {
      await actions.remove.mutateAsync(p.id);
    } catch (e) {
      toastError(e);
    }
  };

  const cover = p.cover_frame;
  const coverUrl = cover !== null && ver ? `/api/review/${enc(data.slug)}/frame?v=${ver.v}&frame=${cover}&size=thumb` : null;
  const ar = ver ? ver.width / ver.height : 16 / 9;

  return (
    <div className="pub-form" data-testid={`pub-form-${p.platform}`} data-post={p.id}>
      {p.state !== 'draft' && <StateLine post={p} actions={actions} />}
      {loose.length > 0 && <Problems list={loose} platform={p.platform} />}
      <div className="pub-cols">
        <div className="pub-col">
          <Field label={t('Where it goes')} problems={[...byField('connection'), ...byField('account')]} platform={p.platform}>
            {choices.length ? (
              <div className="pub-where">
                <Select
                  label={t('Connection')}
                  value={p.connection ?? ''}
                  onChange={(v) => change({ connection: v || null })}
                  options={[{ value: '', label: t('None: only the kit') }, ...choices.map((c) => ({ value: c.id, label: c.label }))]}
                />
                {accounts.length > 1 ? (
                  <Select
                    label={p.platform === 'facebook' ? t('Page') : t('Account')}
                    value={p.account ?? ''}
                    onChange={(v) => change({ account: v || null })}
                    options={accounts.map((a) => ({ value: a.id, label: a.detail ? `${a.name} (${a.detail})` : a.name }))}
                  />
                ) : accounts[0] ? (
                  <span className="pub-as">
                    {t('as {account}', { account: accounts[0].detail ? `${accounts[0].name} (${accounts[0].detail})` : accounts[0].name })}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="pub-hint" data-testid="pub-no-connection">
                {can('publish') ? (
                  <>
                    {t('No {platform} connection yet.', { platform: PLATFORM_LABEL[p.platform] })}{' '}
                    <a href="#/settings/publishing">{t('Connect one in Settings → Publishing')}</a>
                  </>
                ) : (
                  t('No {platform} connection yet: an owner or admin connects one. The kit works without.', { platform: PLATFORM_LABEL[p.platform] })
                )}
              </p>
            )}
          </Field>
          {L.title > 0 && (
            <Field
              label={t('Title')}
              count={{ n: [...title.value].length, max: L.title }}
              problems={byField('title')}
              platform={p.platform}
              htmlFor={`pub-title-${p.id}`}
            >
              <input
                id={`pub-title-${p.id}`}
                className="input"
                value={title.value}
                onChange={(e) => title.set(e.target.value)}
                onBlur={() => void title.flush()}
                data-testid="pub-title"
              />
            </Field>
          )}
          <Field
            label={isYT ? t('Description') : t('Caption')}
            count={{ n: descLength, max: L.description }}
            problems={byField('description')}
            platform={p.platform}
            htmlFor={`pub-desc-${p.id}`}
          >
            <textarea
              id={`pub-desc-${p.id}`}
              className="textarea pub-desc"
              value={description.value}
              onChange={(e) => description.set(e.target.value)}
              onBlur={() => void description.flush()}
              rows={5}
              data-testid="pub-description"
            />
          </Field>
          <Field
            label={isYT ? t('Tags') : t('Hashtags')}
            count={isYT ? { n: tagCount, max: L.tagsTotal ?? 500 } : L.hashtags ? { n: tagCount, max: L.hashtags } : undefined}
            hint={t('Separate them with commas')}
            problems={byField('tags')}
            platform={p.platform}
            htmlFor={`pub-tags-${p.id}`}
          >
            <input
              id={`pub-tags-${p.id}`}
              className="input"
              value={tags.value}
              placeholder={isYT ? t('launch, product film') : t('launch, behindthescenes')}
              onChange={(e) => tags.set(e.target.value)}
              onBlur={() => void tags.flush()}
              data-testid="pub-tags"
            />
          </Field>
        </div>
        <div className="pub-col">
          <Field label={t('Cover')} problems={byField('cover_frame')} platform={p.platform}>
            <div className="pub-cover">
              <span className="pub-cover-frame" style={{ aspectRatio: String(ar) }}>
                {coverUrl ? <img src={coverUrl} alt={t('Cover: frame {frame}', { frame: cover ?? '' })} /> : <span>{t('The platform’s choice')}</span>}
              </span>
              <span className="pub-cover-side">
                {cover !== null && (
                  <span className="mono pub-cover-tc" data-testid="pub-cover-tc">
                    {timecode(cover, fps)}
                  </span>
                )}
                <button type="button" className="btn sm" onClick={() => change({ cover_frame: live.get() })} data-testid="pub-cover-now">
                  {t('Use the frame on screen')}
                </button>
                <button type="button" className="btn sm ghost" onClick={onPickCover} data-testid="pub-cover-pick-start">
                  {t('Pick on the player…')}
                </button>
                {cover !== null && (
                  <button type="button" className="btn sm ghost" onClick={() => change({ cover_frame: null })}>
                    {t('Clear')}
                  </button>
                )}
              </span>
            </div>
          </Field>
          <Field label={t('Who sees it')} problems={byField('visibility')} platform={p.platform}>
            {L.visibilities.length > 1 ? (
              <Choice
                label={t('Who sees it')}
                value={p.visibility}
                onChange={(v) => change({ visibility: v as PostView['visibility'] })}
                options={L.visibilities.map((v) => ({ value: v, label: visibilityWord(v) }))}
                testid="pub-visibility"
              />
            ) : (
              <span className="pub-as">{t('Public: {platform} posts are public', { platform: PLATFORM_LABEL[p.platform] })}</span>
            )}
          </Field>
          <Field label={t('When')} problems={byField('schedule_at')} platform={p.platform}>
            <div className="pub-when">
              <Choice
                label={t('When')}
                value={p.schedule_at ? 'later' : 'now'}
                onChange={(v) => change({ schedule_at: v === 'later' ? tomorrowAt10() : null })}
                options={[
                  { value: 'now', label: t('When it’s published') },
                  { value: 'later', label: t('At a time') },
                ]}
                testid="pub-when"
              />
              {p.schedule_at && (
                <input
                  type="datetime-local"
                  className="input pub-time"
                  aria-label={t('When it goes live')}
                  value={localInput(p.schedule_at)}
                  onChange={(e) => {
                    const d = new Date(e.target.value);
                    if (!Number.isNaN(d.getTime())) change({ schedule_at: d.toISOString() });
                  }}
                  data-testid="pub-time"
                />
              )}
            </div>
          </Field>
          <Field label={t('Contains realistic AI-generated or altered people, places or events?')} problems={byField('ai_generated')} platform={p.platform}>
            <YesNo label={t('AI-generated or altered')} value={p.ai_generated} onChange={(v) => change({ ai_generated: v })} testid="pub-ai" />
          </Field>
          {isYT && (
            <>
              <Field label={t('Made for kids?')} problems={byField('youtube')} platform={p.platform}>
                <YesNo
                  label={t('Made for kids')}
                  value={p.youtube?.made_for_kids ?? null}
                  onChange={(v) => change({ youtube: { made_for_kids: v } })}
                  testid="pub-kids"
                />
              </Field>
              <Field label={t('Category')} platform={p.platform}>
                <Select
                  label={t('Category')}
                  value={p.youtube?.category ?? '22'}
                  onChange={(v) => change({ youtube: { category: v } })}
                  options={YOUTUBE_CATEGORIES.map((c) => ({ value: c.id, label: c.name }))}
                />
              </Field>
            </>
          )}
          {p.platform === 'instagram' && (
            <Field label={t('Post it as')} platform={p.platform}>
              <div className="pub-when">
                <Choice
                  label={t('Post it as')}
                  value={p.instagram?.kind ?? 'reel'}
                  onChange={(v) => change({ instagram: { kind: v as 'reel' | 'feed' } })}
                  options={[
                    { value: 'reel', label: t('Reel') },
                    { value: 'feed', label: t('Video in the feed') },
                  ]}
                  testid="pub-ig-kind"
                />
                {(p.instagram?.kind ?? 'reel') === 'reel' && (
                  <span className="pub-switch">
                    <Switch
                      id={`pub-feed-${p.id}`}
                      checked={p.instagram?.share_to_feed ?? true}
                      onCheckedChange={(on) => change({ instagram: { share_to_feed: on } })}
                    />
                    <label htmlFor={`pub-feed-${p.id}`}>{t('Also in the feed')}</label>
                  </span>
                )}
              </div>
            </Field>
          )}
        </div>
      </div>
      <Kit post={p} />
      <div className="pub-foot">
        <span className="pub-foot-who">
          {draftedBy(p)}
          {saving > 0 ? ` · ${t('Saving…')}` : ''}
        </span>
        {/* one the platform holds (it went out before) stays: what happened to it is its history (A12 PUB-6) */}
        {!p.remote_id && (
          <button type="button" className="btn ghost danger sm" onClick={remove} data-testid="pub-delete">
            {t('Delete draft')}
          </button>
        )}
        {can('publish') ? (
          <span className="pub-go">
            {needs.length > 0 && (
              <span className="pub-needs" data-testid="pub-needs">
                {t('{n} thing to settle first|{n} things to settle first', { n: needs.length })}
              </span>
            )}
            <button type="button" className="btn primary" disabled={needs.length > 0} onClick={publish} data-testid="pub-publish">
              <I name="upload" size={15} /> {t('Publish to {platform}', { platform: PLATFORM_LABEL[p.platform] })}
            </button>
          </span>
        ) : (
          <span className="pub-hint">{t('An owner or admin publishes it.')}</span>
        )}
      </div>
      {confirmation}
    </div>
  );
}

/** A field: its label, a counter against the platform's limit, the control, what it breaks. */
function Field({
  label,
  count,
  hint,
  problems = [],
  platform,
  htmlFor,
  children,
}: {
  label: string;
  count?: { n: number; max: number };
  hint?: string;
  problems?: PostProblem[];
  platform: PublishPlatform;
  htmlFor?: string;
  children: ReactNode;
}) {
  const over = count && count.n > count.max;
  return (
    <div className="pub-field">
      <div className="pub-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <span className="pub-label-hint">{hint}</span>}
        {count && (
          <span className={`pub-count ${over ? 'over' : ''}`} data-testid="pub-count">
            {count.n.toLocaleString(locale())} / {count.max.toLocaleString(locale())}
          </span>
        )}
      </div>
      {children}
      {problems.length > 0 && <Problems list={problems} platform={platform} />}
    </div>
  );
}

function Problems({ list, platform }: { list: PostProblem[]; platform: PublishPlatform }) {
  return (
    <ul className="pub-problems">
      {list.map((x) => (
        <li key={`${x.code}:${x.field}`} className={blocking(x) ? 'block' : 'warn'} data-code={x.code}>
          <I name={blocking(x) ? 'info' : 'help'} size={13} />
          <span>{problemText(x, platform)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One of a few, as a segmented row (radio semantics: ui/toggle.tsx). */
function Choice({
  label,
  value,
  onChange,
  options,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testid?: string;
}) {
  return (
    <span className="pub-seg" data-testid={testid}>
      <Segmented label={label} value={value} onChange={(v) => v && v !== value && onChange(v)} options={options} />
    </span>
  );
}

/** A required yes or no: nothing chosen until the person chooses. */
function YesNo({ label, value, onChange, testid }: { label: string; value: boolean | null; onChange: (v: boolean) => void; testid: string }) {
  return (
    <Choice
      label={label}
      value={value === null ? '' : value ? 'yes' : 'no'}
      onChange={(v) => onChange(v === 'yes')}
      options={[
        { value: 'yes', label: t('Yes') },
        { value: 'no', label: t('No') },
      ]}
      testid={testid}
    />
  );
}

// ---------------------------------------------------------------- where a post stands

/** A failed or cancelled post's line over its form: why, and the way on (as it was, or changed below and published). */
function StateLine({ post: p, actions }: { post: PostView; actions: Actions }) {
  return (
    <div className={`pub-state s-${p.state}`} data-testid="pub-state" data-state={p.state}>
      <KeyGlyph shape={POST_SHAPE[p.state]} size={9} />
      <span>
        <b>{stateWord(p.state)}</b>
        {p.error ? ` · ${p.error}` : ''}
      </span>
      <RetryButton post={p} actions={actions} />
    </div>
  );
}

/**
 * Retry, as the post allows (A12 PUB-1): one that never reached the platform is sent again ("Try again"); one the
 * platform holds is only asked about ("Check again"); one sent without an answer is posted again only after the person
 * says so, having looked on the platform ("Post again").
 */
function RetryButton({ post: p, actions, primary = false }: { post: PostView; actions: Actions; primary?: boolean }) {
  const can = useCan();
  const [ask, confirmation] = useConfirm();
  if (!can('publish') || (p.state !== 'failed' && p.state !== 'sent')) return null;
  const way = p.remote_id ? 'check' : p.state === 'sent' ? 'again' : 'send';
  const name = PLATFORM_LABEL[p.platform];
  const run = async () => {
    if (way === 'again') {
      const w = againWords(p);
      if (!(await ask({ title: w.title, body: <p data-testid="pub-again">{w.body}</p>, action: w.action }))) return;
    }
    try {
      await actions.retry.mutateAsync({ id: p.id, again: way === 'again' });
      toast(way === 'check' ? t('Asking {platform} where it stands', { platform: name }) : t('Sending it again'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <button
        type="button"
        className={primary ? 'btn sm primary' : 'btn sm'}
        onClick={run}
        disabled={actions.retry.isPending}
        data-testid="pub-retry"
        data-way={way}
      >
        <I name="refresh" size={14} /> {way === 'check' ? t('Check again') : way === 'again' ? t('Post again') : t('Try again')}
      </button>
      {confirmation}
    </>
  );
}

function PostStatus({ post: p, actions, hosted }: { post: PostView; actions: Actions; hosted: boolean }) {
  const can = useCan();
  const [cancelled, setCancelled] = useState<{ message: string; next?: string } | null>(null);
  const [ask, confirmation] = useConfirm();
  const name = PLATFORM_LABEL[p.platform];
  const cancel = async () => {
    if (!(await ask({ title: t('Take back the {platform} post?', { platform: name }), action: t('Take it back'), danger: true }))) return;
    try {
      await actions.cancel.mutateAsync(p.id);
    } catch (e) {
      const next = e instanceof ApiError && typeof e.details.next === 'string' ? e.details.next : undefined;
      setCancelled({ message: (e as Error).message, next });
    }
  };
  const pct = p.progress?.total ? Math.round((p.progress.sent / p.progress.total) * 100) : null;
  const holds = p.holds_schedule;
  return (
    <div className="pub-status" data-testid="pub-status" data-state={p.state}>
      <div className={`pub-state s-${p.state}`}>
        <KeyGlyph shape={POST_SHAPE[p.state]} size={10} />
        <span>
          <b data-testid="pub-status-word">
            {p.state === 'posted'
              ? t('Posted on {platform}', { platform: name })
              : p.state === 'scheduled'
                ? t('Scheduled on {platform}', { platform: name })
                : p.state === 'uploading'
                  ? t('Sending to {platform}', { platform: name })
                  : p.state === 'queued'
                    ? t('Waiting to go out')
                    : stateWord(p.state)}
          </b>
          {p.account_name ? ` · ${t('as {account}', { account: p.account_name })}` : ''}
        </span>
        {p.url && (p.state === 'posted' || p.state === 'scheduled') && (
          <a className="btn sm" href={p.url} target="_blank" rel="noreferrer" data-testid="pub-url">
            {t('Open on {platform}', { platform: name })} <I name="external" size={13} />
          </a>
        )}
      </div>
      {p.state === 'uploading' && <Progress value={pct} label={t('Sending to {platform}', { platform: name })} className="pub-progress" />}
      {p.state === 'queued' && p.error && <p className="pub-warn">{t('Trying again: {error}', { error: p.error })}</p>}
      {p.state === 'queued' && p.schedule_at && Date.parse(p.schedule_at) > Date.now() && (
        <p className="pub-line">
          {t('Goes out {when}.', { when: whenWords(p.schedule_at) })}{' '}
          {!holds && !hosted ? t('Lampo sends it then: keep this machine awake and Lampo running.') : ''}
        </p>
      )}
      {p.state === 'scheduled' && p.schedule_at && (
        <p className="pub-line">
          {t('Goes live {when}.', { when: whenWords(p.schedule_at) })} {holds ? t('{platform} holds it: this machine may sleep.', { platform: name }) : ''}
        </p>
      )}
      {p.state === 'posted' && p.published_at && (
        <p className="pub-line">{t('Published {when} by {name}.', { when: ago(p.published_at), name: p.published_by ?? '' })}</p>
      )}
      {p.locked && (
        <div className="pub-locked" data-testid="pub-locked">
          <p>
            {t(
              'YouTube kept it private: uploads from a Google project that hasn’t passed YouTube’s API audit stay private, scheduled ones too. Make it public in YouTube Studio.',
            )}
          </p>
          {p.studio_url && (
            <a className="btn sm" href={p.studio_url} target="_blank" rel="noreferrer" data-testid="pub-studio">
              {t('Open in YouTube Studio')} <I name="external" size={13} />
            </a>
          )}
        </div>
      )}
      {(p.state === 'failed' || p.state === 'cancelled' || p.state === 'sent') && (
        <div className="pub-failed">
          <p>
            {p.error ||
              (p.state === 'sent'
                ? t('{platform} never said whether it arrived: look on {platform}, then check again or post it again.', { platform: name })
                : '')}
          </p>
          <RetryButton post={p} actions={actions} primary />
        </div>
      )}
      <dl className="pub-facts">
        <div>
          <dt>{t('Version')}</dt>
          <dd>V{p.v}</dd>
        </div>
        {p.title && (
          <div>
            <dt>{t('Title')}</dt>
            <dd>{p.title}</dd>
          </div>
        )}
        <div>
          <dt>{t('Who sees it')}</dt>
          <dd>{visibilityWord(p.visibility)}</dd>
        </div>
        {p.file && (
          <div>
            <dt>{t('File')}</dt>
            <dd>
              {p.file.kind === 'final'
                ? t('The final version as it is · {size}', { size: bytes(p.file.bytes) })
                : t('The platform’s encode of it · {size}', { size: bytes(p.file.bytes) })}
            </dd>
          </div>
        )}
      </dl>
      {cancelled && (
        <p className="pub-warn" data-testid="pub-cancel-note">
          {cancelled.message}
          {cancelled.next?.startsWith('https://') && (
            <>
              {' '}
              <a href={cancelled.next} target="_blank" rel="noreferrer">
                {t('Open in YouTube Studio')} <I name="external" size={12} />
              </a>
            </>
          )}
        </p>
      )}
      <History post={p} />
      <Kit post={p} />
      {can('publish') && (p.state === 'queued' || p.state === 'scheduled') && (
        <div className="pub-foot">
          <span className="pub-foot-who" />
          <button type="button" className="btn ghost danger sm" onClick={cancel} data-testid="pub-cancel">
            {t('Take it back')}
          </button>
        </div>
      )}
      {confirmation}
    </div>
  );
}

function History({ post: p }: { post: PostView }) {
  if (!p.history.length) return null;
  return (
    <details className="pub-history">
      <summary>{t('History · {n}', { n: p.history.length })}</summary>
      <ol>
        {[...p.history].reverse().map((h) => (
          <li key={`${h.at}:${h.state}:${h.note ?? ''}`}>
            <KeyGlyph shape={POST_SHAPE[h.state]} size={7} />
            <span>
              <b>{stateWord(h.state)}</b> · {h.by === 'system' ? 'Lampo' : h.by.replace(/^agent:/, '')} · {ago(h.at)}
              {h.note ? ` · ${h.note}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---------------------------------------------------------------- the publish kit

const KIT_WORDS: Record<KitFile['kind'], () => string> = {
  video: () => t('The encode'),
  captions: () => t('Captions (SRT)'),
  cover: () => t('Cover'),
  copy: () => t('The words as text'),
  zip: () => t('All of it (ZIP)'),
};

/** The platform's encode, an SRT of what is said, the cover and the words: to post by hand, no connection needed. */
function Kit({ post: p }: { post: PostView }) {
  const actions = usePostActions(p.slug);
  const [asked, setAsked] = useState(false);
  const polled = useKit(p.id, asked || p.kit?.state === 'making').data;
  const kit: KitInfo | null = polled && polled.state !== 'none' ? (polled as KitInfo) : (p.kit ?? null);
  const make = () => {
    setAsked(true);
    actions.kit.mutate(p.id, { onError: toastError });
  };
  const making = kit?.state === 'making' || actions.kit.isPending;
  return (
    <section className="pub-kit" data-testid="pub-kit" data-state={kit?.state ?? 'none'}>
      <div className="pub-kit-head">
        <I name="download" size={15} />
        <span className="pub-kit-text">
          <b>{t('Publish kit')}</b>
          <span>{t('The {platform} encode, captions, the cover and the words, to post by hand.', { platform: PLATFORM_LABEL[p.platform] })}</span>
        </span>
        <button type="button" className="btn sm" onClick={make} disabled={making} data-testid="pub-kit-make">
          {making ? t('Making the kit…') : kit?.state === 'ready' ? t('Make it again') : t('Make the kit')}
        </button>
      </div>
      {kit?.state === 'failed' && <p className="pub-warn">{kit.error}</p>}
      {kit?.state === 'ready' && (
        <ul className="pub-kit-files">
          {kit.files.map((f) => (
            <li key={f.name}>
              <a
                href={`/api/posts/${enc(p.id)}/kit/${enc(f.name)}`}
                download={f.name}
                className={f.kind === 'zip' ? 'btn sm primary' : 'btn sm ghost'}
                data-testid={`pub-kit-${f.kind}`}
              >
                <I name="download" size={13} /> {KIT_WORDS[f.kind]()} <span className="pub-kit-size">{bytes(f.bytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
