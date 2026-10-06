// Owner side of review links: make one for a video or a whole folder, decide what visitors may do, see who opened
// it, change or revoke it later, and (locally) make links reachable from anywhere through a Cloudflare tunnel.
// Who it's for, one of three kinds of link, and every setting in view as a row with its name and its switch
// (LinkSettings.tsx); the links already made are one line each, and Change link opens one as its own page in the
// dialog, with the same rows.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useShareActions } from '../api/mutations.ts';
import { useFolderShares, useInfo, useShares, useTunnel } from '../api/queries.ts';
import type { ShareInfo, ShareInput } from '../api/types.ts';
import { isProject } from '../lib/folders.ts';
import { useTouch } from '../lib/media.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Confirm, Modal, Segmented } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Tip } from '../ui/tip.tsx';
import { type Access, type Draft, passwordProblem } from './draft.ts';
import { embedCode, embedSrc } from './embedCode.ts';
import { LinkCard, type Reach } from './LinkCard.tsx';
import { LinkSettings } from './LinkSettings.tsx';
import '../styles/share-links.css';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';

const accessOf = (s: { comment: boolean; approve: boolean }): Access => (!s.comment ? 'watch' : s.approve ? 'review' : 'comment');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');
const fresh = (label = ''): Draft => ({
  label,
  access: 'review',
  notes: 'own',
  versions: 'latest',
  download: 'off',
  expires: '',
  password: '',
  passwordAction: 'keep',
  embed: false,
});
const draftOf = (s: ShareInfo): Draft => ({
  label: s.label,
  access: accessOf(s),
  notes: s.notes,
  versions: s.versions,
  download: s.download,
  expires: day(s.expires),
  password: '',
  passwordAction: 'keep',
  embed: !!s.embed,
});

function inputOf(d: Draft, editing: boolean): ShareInput {
  const out: ShareInput = {
    label: d.label.trim() || undefined,
    comment: d.access !== 'watch',
    approve: d.access === 'review',
    // only plays: no one else's notes (the switch shows off and can't be changed; A13 LINK-2)
    notes: d.access === 'watch' ? 'own' : d.notes,
    versions: d.versions,
    download: d.download,
    // The end of the chosen day, in the owner's time zone.
    expires: d.expires ? new Date(`${d.expires}T23:59:59`).toISOString() : null,
    embed: d.embed,
  };
  // an embed never has a password: a link changed into one loses the one it had
  if (d.embed) {
    if (editing) out.password = null;
    return out;
  }
  if (!editing) out.password = d.passwordAction === 'set' && d.password ? d.password : undefined;
  else if (d.passwordAction === 'remove') out.password = null;
  else if (d.passwordAction === 'set' && d.password) out.password = d.password;
  return out;
}

// What a link is for, in one of four words: most links are one of these. Anything else reads as "custom". An embed is
// a video's: a folder's dialog offers the first three.
type PresetId = 'review' | 'watch' | 'handoff' | 'embed';
type Kind = Pick<Draft, 'access' | 'notes' | 'versions' | 'download' | 'embed'>;
const PRESETS: { id: PresetId; label: () => string; set: Kind }[] = [
  { id: 'review', label: () => t('Review'), set: { access: 'review', notes: 'own', versions: 'latest', download: 'off', embed: false } },
  { id: 'watch', label: () => t('Watch only'), set: { access: 'watch', notes: 'own', versions: 'latest', download: 'off', embed: false } },
  { id: 'handoff', label: () => t('Delivery'), set: { access: 'watch', notes: 'own', versions: 'latest', download: 'original', embed: false } },
  { id: 'embed', label: () => t('Embed'), set: { access: 'watch', notes: 'own', versions: 'latest', download: 'off', embed: true } },
];
// Which notes visitors see doesn't matter to someone who only watches.
const presetOf = (d: Draft): PresetId | '' =>
  PRESETS.find(
    (p) =>
      p.set.embed === d.embed &&
      p.set.access === d.access &&
      p.set.versions === d.versions &&
      p.set.download === d.download &&
      (d.access === 'watch' || p.set.notes === d.notes),
  )?.id ?? '';

export function ShareModal({
  slug,
  name,
  folder,
  edit,
  onClose,
}: {
  slug?: string;
  name?: string;
  folder?: string;
  /** A link of this video or folder to open for changing (from Settings → Review links). */
  edit?: string;
  onClose: () => void;
}) {
  const target = folder ? { folder } : { slug: slug as string };
  const here: 'video' | 'folder' = folder ? 'folder' : 'video';
  const videoQ = useShares(slug || '');
  const folderQ = useFolderShares(folder || '');
  const { data: d, error } = folder ? folderQ : videoQ;
  const info = useInfo();
  // A hosted server is reachable already: links use its public URL, and there is no tunnel to start.
  const hosted = info?.mode === 'server';
  const tunnel = useTunnel().data ?? { available: false, running: false, url: null };
  const act = useShareActions(target);
  const [draft, setDraft] = useState<Draft>(fresh());
  // A new form after each link: the limits it had open close with it (an expiry block stayed, saying "Never expires").
  const [form, setForm] = useState(0);
  const [editing, setEditing] = useState<{ token: string; d: Draft } | null>(null);
  // A create or save was tried with a password that can't go with the link: the field says why, where it is typed.
  const [checked, setChecked] = useState(false);
  const [editChecked, setEditChecked] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const editPasswordRef = useRef<HTMLInputElement>(null);
  const [revoking, setRevoking] = useState<ShareInfo | null>(null);
  // an embed just made: its line opens with its code in view
  const [opened, setOpened] = useState<string | null>(null);
  // Phones and tablets: the system share sheet (Messages, WhatsApp, Mail…) next to Copy.
  const canShare = useTouch() && typeof navigator.share === 'function';
  useEffect(() => {
    if (error) toastError(error);
  }, [error]);
  // Opened to change one link: its form, once the links are in.
  const toEdit = useRef(edit);
  useEffect(() => {
    const s = toEdit.current && d?.shares.find((x) => x.token === toEdit.current);
    if (!s) return;
    toEdit.current = undefined;
    setEditing({ token: s.token, d: draftOf(s) });
  }, [d]);

  const base = hosted ? (info?.public_url || location.origin).replace(/\/+$/, '') : tunnel.url || d?.lan?.[0] || location.origin;
  const reachKind: Reach = hosted || tunnel.url ? 'public' : d?.lan?.length ? 'lan' : 'local';
  const reach = reachKind === 'public' ? t('anyone with the link') : reachKind === 'lan' ? t('people on your network') : t('this computer only');
  const urlOf = (s: ShareInfo) => `${base}/g/${s.token}`;
  /** What a new link puts on the clipboard: its address, or an embed's code for a site's page. */
  const copyOf = (s: ShareInfo) => (s.embed ? embedCode({ src: embedSrc(urlOf(s)), title: s.name ?? s.label, width: s.width, height: s.height }) : urlOf(s));
  // The form clears the moment a link is sent, not when the round trip ends: that waits for the list's refetch too, and
  // by then the person may be typing the next link's name — a late reset wiped it. A failure puts the sent form back,
  // unless the next one has been started since.
  const now = useRef(draft);
  now.current = draft;
  const blank = useRef<Draft | null>(null);

  const create = async () => {
    // a second ↵ before the first link is back: the cleared form isn't a link of its own
    if (act.create.isPending && draft === blank.current) return;
    if (passwordProblem(draft)) {
      // say what's wrong under the field, and put the cursor there
      setChecked(true);
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
    const sent = { draft };
    const cleared = fresh();
    blank.current = cleared;
    setDraft(cleared);
    setForm((n) => n + 1);
    setChecked(false);
    try {
      const s = await act.create.mutateAsync(inputOf(sent.draft, false));
      // with a password: both on the clipboard, ready to send (it can't be shown again: the server keeps it scrambled)
      const password = sent.draft.passwordAction === 'set' && !sent.draft.embed ? sent.draft.password : '';
      if (s.embed) {
        // the code to paste into a site's page; its line opens with it in view
        setOpened(s.token ?? null);
        if (await copyText(copyOf(s))) toast(t('Embed code copied · reachable by {reach}', { reach }), 'ok');
      } else if (await copyText(password ? `${urlOf(s)}\n${t('Password')}: ${password}` : urlOf(s)))
        toast(
          password ? t('Link and password copied · reachable by {reach}', { reach }) : t('Link created and copied · reachable by {reach}', { reach }),
          'ok',
        );
    } catch (e) {
      if (now.current === cleared) {
        setDraft(sent.draft);
        setForm((n) => n + 1);
      }
      toastError(e);
    }
  };
  // ↵ in the name creates the link; ⌘↵ anywhere in the create block does too (the dialog has no foot for it).
  const createKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const inName = (e.target as HTMLElement).matches('[data-testid=link-name]');
    if (!inName && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    create();
  };
  // Opened from Settings to change one link: done with it, the dialog is done too.
  const leave = () => {
    setEditing(null);
    if (edit) onClose();
  };
  const save = async () => {
    if (!editing) return;
    if (passwordProblem(editing.d)) {
      setEditChecked(true);
      editPasswordRef.current?.focus();
      return;
    }
    const sent = editing;
    try {
      await act.update.mutateAsync({ token: editing.token, input: inputOf(editing.d, true) });
      toast(t('Link updated'), 'ok');
      if (edit) onClose();
      else setEditing((cur) => (cur === sent ? null : cur));
    } catch (e) {
      toastError(e);
    }
  };
  const revoke = async (token: string) => {
    try {
      await act.revoke.mutateAsync(token);
      setRevoking(null);
      if (editing?.token === token) leave();
      toast(t('Link revoked: it stops working right away'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const startTunnel = () => act.startTunnel.mutateAsync().catch(toastError);

  const title = folder
    ? isProject(folder)
      ? t('Share project {folder}', { folder })
      : t('Share folder {folder}', { folder })
    : t('Share {name}', { name: name ?? '' });
  const empty = !!d && !d.shares.length;
  // an embed plays one video on someone else's page: a folder's links are the first three kinds
  const offered = here === 'video' ? PRESETS : PRESETS.filter((p) => p.id !== 'embed');
  const kinds = (of: Draft, change: (p: Partial<Draft>) => void) => (
    <Segmented
      label={t('Kind of link')}
      value={presetOf(of)}
      onChange={(v) => {
        const p = PRESETS.find((x) => x.id === v);
        // an embed has no password: one being set goes with the kind (an existing link's is removed on save)
        if (p) change(p.set.embed ? { ...p.set, password: '', passwordAction: 'keep' } : p.set);
      }}
      options={offered.map((p) => ({ value: p.id, label: p.label() }))}
    />
  );

  const creator = (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ for the block; the field and the buttons are the controls
    <div className="link-new" onKeyDown={createKeys}>
      <div className="link-new-row">
        <input
          className="input grow"
          data-testid="link-name"
          aria-label={t('Who is the link for?')}
          placeholder={t('Who is it for?')}
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
        <button type="button" className="btn primary" onClick={create} disabled={act.create.isPending} data-testid="link-create">
          {act.create.isPending ? <Spinner /> : <I name="link" size={15} />} {t('Create link')}
        </button>
      </div>
      <div className="link-kind">{kinds(draft, (p) => setDraft((x) => ({ ...x, ...p })))}</div>
      <LinkSettings
        key={form}
        d={draft}
        set={(p) => setDraft((x) => ({ ...x, ...p }))}
        editing={false}
        hasPassword={false}
        checked={checked}
        passwordRef={passwordRef}
      />
    </div>
  );

  // Where links open, honestly, with the one thing that changes it (hosted: every link opens for anyone, nothing to say).
  const where = !hosted && (
    <div className={`link-where ${reachKind}`} data-testid="link-where">
      <span className="link-where-icon" aria-hidden="true">
        <I name={reachKind === 'public' ? 'globe' : reachKind === 'lan' ? 'users' : 'lock'} size={15} />
      </span>
      <div className="link-where-text">
        <b>
          {tunnel.running ? t('Anyone with a link can open it') : reachKind === 'lan' ? t('Links open on your network') : t('Links open on this computer only')}
        </b>
        <span>
          {tunnel.running ? (
            t('Through a temporary Cloudflare tunnel, until you stop it or the app stops.')
          ) : tunnel.available ? (
            t('Make them public to send one to anyone.')
          ) : (
            <T k="Install <0>cloudflared</0> to make them public." tags={[(c) => <span className="mono">{c}</span>]} />
          )}
        </span>
      </div>
      {tunnel.available &&
        (tunnel.running ? (
          <button type="button" className="btn sm" onClick={() => act.stopTunnel.mutateAsync().catch(toastError)}>
            {t('Stop public access')}
          </button>
        ) : (
          <Tip
            content={t(
              'Starts a temporary Cloudflare quick tunnel (no account). Only review links answer through it; the library, other videos and the API stay on this computer.',
            )}
          >
            <button type="button" className="btn sm" onClick={startTunnel} disabled={act.startTunnel.isPending}>
              {act.startTunnel.isPending ? <Spinner /> : <I name="globe" size={14} />} {t('Make links public')}
            </button>
          </Tip>
        ))}
    </div>
  );

  // The link being changed, as the list has it (gone from it: revoked elsewhere, the page goes back).
  const changing = editing ? (d?.shares.find((x) => x.token === editing.token) ?? null) : null;

  return (
    <Modal title={title} onClose={onClose} width={660}>
      {/* The links and the page of one link being changed share one cell: the dialog keeps its height between them. */}
      <div className="link-views">
        <div className="link-view" inert={!!changing} aria-hidden={changing ? true : undefined}>
          <p className="link-intro">
            {folder
              ? t('A project or folder link opens a review room with every video in it and in its folders, including ones you add later.')
              : t('A review link shows this video to people without an account.')}{' '}
            {t('They never see your internal notes.')}
          </p>
          {/* Who the link says it's from: visitors see a name someone chose to go by, never the computer's login name. */}
          <p className={`link-sharer ${d && !d.sharer ? 'unnamed' : ''}`} data-testid="link-sharer">
            <I name="user" size={13} />
            {!d ? (
              <SkLine w="16em" />
            ) : d.sharer ? (
              <span>{t('Visitors see it’s from {name}.', { name: d.sharer })}</span>
            ) : (
              <>
                <span>{t('Visitors won’t see who shared it.')}</span>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    onClose();
                    location.hash = '#/settings/profile';
                  }}
                >
                  {t('Add your name')}
                </button>
              </>
            )}
          </p>
          {empty && (
            <EmptyState size="sm" art="client" className="link-empty" title={t('No links yet')}>
              {t('Say who it’s for and create the first one: they review without an account.')}
            </EmptyState>
          )}
          {creator}
          {!d ? (
            <SkeletonRegion label={t('Loading the links')}>
              <RowsSkeleton n={2} thumb={false} />
            </SkeletonRegion>
          ) : (
            !empty && (
              <section className="link-made" aria-label={here === 'folder' ? t('Links to this folder') : t('Links to this video')}>
                <div className="link-made-head">
                  <h3>
                    {here === 'folder' ? t('Links to this folder') : t('Links to this video')} <span className="link-made-n">{d.shares.length}</span>
                  </h3>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      onClose();
                      location.hash = '#/settings/links';
                    }}
                    data-testid="link-all"
                  >
                    {t('All links')} <I name="right" size={12} />
                  </button>
                </div>
                <div className="link-list">
                  {d.shares.map((s) => (
                    <LinkCard
                      key={s.token}
                      s={s}
                      opened={opened === s.token}
                      url={urlOf(s)}
                      reach={reachKind}
                      here={here}
                      canShare={canShare}
                      editing={editing?.token === s.token}
                      onEdit={() => {
                        setEditChecked(false);
                        setEditing({ token: s.token, d: draftOf(s) });
                      }}
                      onRevoke={() => setRevoking(s)}
                    />
                  ))}
                </div>
              </section>
            )
          )}
          {where}
        </div>
        {changing && editing && (
          <div className="link-view link-change" data-testid="link-change">
            <div className="link-change-head">
              <button type="button" className="btn sm ghost link-back" onClick={leave} data-testid="link-back">
                <I name="back" size={14} /> {edit ? t('Cancel') : here === 'folder' ? t('Links to this folder') : t('Links to this video')}
              </button>
              <span className={`link-state ${changing.expired ? 'off' : ''}`}>{changing.expired ? t('Expired') : t('Active')}</span>
            </div>
            <div className="link-change-name">
              <label className="link-change-label" htmlFor="link-change-name">
                {t('Name')}
              </label>
              <input
                id="link-change-name"
                className="input"
                data-testid="link-change-name"
                value={editing.d.label}
                onChange={(e) => setEditing({ ...editing, d: { ...editing.d, label: e.target.value } })}
              />
            </div>
            <div className="link-kind">{kinds(editing.d, (p) => setEditing((x) => x && { ...x, d: { ...x.d, ...p } }))}</div>
            <LinkSettings
              key={editing.token}
              d={editing.d}
              set={(p) => setEditing((x) => x && { ...x, d: { ...x.d, ...p } })}
              editing
              hasPassword={changing.password}
              checked={editChecked}
              passwordRef={editPasswordRef}
            />
            <div className="link-change-foot">
              <button type="button" className="btn sm ghost danger" onClick={() => setRevoking(changing)}>
                {t('Revoke link')}
              </button>
              <span className="grow" />
              <button type="button" className="btn sm ghost" onClick={leave}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn sm primary" onClick={save} disabled={act.update.isPending} data-testid="link-save">
                {act.update.isPending ? <Spinner /> : <I name="check" size={14} />} {t('Save')}
              </button>
            </div>
          </div>
        )}
      </div>
      {revoking && (
        <Confirm
          title={t('Revoke “{label}”?', { label: revoking.label })}
          action={t('Revoke link')}
          danger
          busy={act.revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={() => revoke(revoking.token)}
        >
          {t('It stops working at once, also where it is open; the notes that came in through it stay.')}
        </Confirm>
      )}
    </Modal>
  );
}
