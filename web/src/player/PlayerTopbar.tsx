// Player header: back, title and version on the left; the quiet tools (compare, the agent, share), then the one
// next-step button; then the inbox and ⋯. One control per job: the agent is one button (ClaudeMenu.tsx), sharing is
// one "Share" button (on phones in ⋯).
import { memo, type ReactNode, useRef } from 'react';
import { useCan } from '../api/auth.ts';
import { enc } from '../api/client.ts';
import type { ReviewResponse, Run, Version } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { InboxBell } from '../inbox/InboxBell.tsx';
import { fileName } from '../lib/format.ts';
import { backToLibrary, crumbs } from '../lib/nav.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { ArchivedBanner } from '../library/ArchivedBanner.tsx';
import { downloadVersion } from '../library/downloadVersion.ts';
import type { RunLike } from '../sessions/runWords.ts';
import { SessionChip } from '../sessions/Sessions.tsx';
import { StageControl, StageLine } from '../status/StageControl.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu, Tip } from '../ui/primitives.tsx';
import { VIDEO_ACCEPT } from '../uploads/formats.ts';
import { AgentMenu } from './ClaudeMenu.tsx';
import { partTag } from './partWords.ts';
import { VersionPicker } from './VersionPicker.tsx';

interface PlayerTopbarProps {
  data: ReviewResponse;
  v: number;
  latestV: number;
  abOn: boolean;
  /** Versions someone approved. */
  approved: Set<number>;
  home?: string | null;
  onVersion: (v: number) => void;
  onToggleAb: () => void;
  /** Compare the version on screen with another one. */
  onCompareWith: (v: number) => void;
  onShare: () => void;
  /** Starts verify mode (the sign-off's "Check the fixes"). */
  onVerify?: () => void;
  /** Opens the publishing composer (a final version's next step, for whoever may draft posts). */
  onPublish?: () => void;
  /** Phones: the name and its stage, the inbox and ⋯ in the bar; version, tools and the next step in a strip under it. */
  phone?: boolean;
  /** Phones: shown in the strip instead of its tools (the compare controls while comparing). */
  strip?: ReactNode;
  /** The frame on screen (the agent's "Quick check: render only this part"). */
  frameNow?: () => number;
  /** Its project is archived (lib/archived.ts): the banner stands where the next step does; `onRestore` for who may. */
  archived?: { onRestore?: () => void } | null;
  /** The video's agent work (the version picker says who made each version), and what the strip speaks of now (the
   * agent button's words follow it). */
  runs?: Run[];
  run?: RunLike | null;
  /** The version picker's "Steps": the Agent view on that work. */
  onSteps?: (id: string) => void;
}

export const PlayerTopbar = memo(function PlayerTopbar({
  data,
  v,
  latestV,
  abOn,
  approved,
  home,
  onVersion,
  onToggleAb,
  onCompareWith,
  onShare,
  onVerify,
  onPublish,
  phone = false,
  strip = null,
  frameNow,
  archived = null,
  runs,
  run = null,
  onSteps,
}: PlayerTopbarProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const { review, summary, slug } = data;
  // Uploaded renders (hosted server): the next version comes as an upload, not a re-render to a path.
  const uploaded = review.video.startsWith('/@uploads/');
  // Reviewers watch, comment and approve; sessions, agents, uploads and links are the team's side.
  const allowed = useCan();
  const picker = useRef<HTMLInputElement>(null);
  const back = <IconButton className="btn ghost sm icon-only" label={t('Back to the library')} icon="back" size={17} onClick={backToLibrary} side="bottom" />;
  const title = (
    <div className="p-title">
      <h1 className="ellipsis" title={review.video}>
        {fileName(review.video)}
      </h1>
      <span className="ellipsis">{review.folder ? crumbs(review.folder) : review.project}</span>
    </div>
  );
  const versions = (
    <VersionPicker
      versions={review.versions}
      v={v}
      latestV={latestV}
      approved={approved}
      onVersion={onVersion}
      onCompare={onCompareWith}
      runs={runs}
      coming={run}
      onSteps={onSteps}
    />
  );
  const compare = (
    <Tip content={t('Compare two versions')} shortcut="B" side="bottom">
      <button type="button" className={`btn sm ghost ${abOn ? 'on' : ''}`} onClick={onToggleAb} aria-pressed={abOn} aria-label={t('Compare')}>
        <I name="compare" size={15} /> <span className="p-tool-word">{t('Compare')}</span>
      </button>
    </Tip>
  );
  const share = allowed('share') && (
    <Tip content={t('Share a review link')} side="bottom">
      <button type="button" className="btn sm ghost" onClick={onShare} aria-label={t('Share')} data-testid="share-button">
        <I name="link" size={15} /> <span className="p-tool-word">{t('Share')}</span>
      </button>
    </Tip>
  );
  // A final video ships: no agent works on it until someone reopens it, so its control goes with it.
  const final = summary.stage.stage === 'final';
  const canAsk = allowed('agents');
  const canAssign = allowed('organize');
  const agent = final ? null : canAsk || canAssign ? (
    <AgentMenu
      slug={slug}
      video={review.video}
      session={review.session}
      sessionActive={summary.sessionActive}
      sessionListening={summary.sessionListening}
      latestV={latestV}
      home={home}
      canAsk={canAsk}
      canAssign={canAssign}
      compact={phone}
      frameNow={frameNow}
      fps={review.versions.at(-1)?.fps}
      noteAt={(id) => review.comments.find((c) => c.id === id)?.timecode ?? null}
      run={run}
    />
  ) : (
    review.session && <SessionChip session={review.session} active={summary.sessionActive} listening={summary.sessionListening} disabled />
  );
  // where the video stands, and the next step as one button (the rest behind its chevron)
  const approval = archived ? (
    <ArchivedBanner onRestore={archived.onRestore} />
  ) : (
    <StageControl data={data} latestV={latestV} onShare={onShare} onVerify={onVerify} onPublish={onPublish} compact={phone} />
  );
  // The version on screen as its own file (as rendered, whatever the browser plays), the others a step further in.
  const canDownload = allowed('download') && !review.archived;
  const versionWords = (x: Version) => [`V${x.v}`, x.v === latestV && t('newest'), x.part && partTag(x.part, x.fps)].filter(Boolean).join(' · ');
  const more = (
    <div style={{ position: 'relative' }}>
      <Menu
        sideOffset={6}
        trigger={<IconButton className="btn sm icon-only ghost" label={t('More')} icon="more" side="bottom" />}
        items={[
          // the sample takes no versions but its own (the server refuses them)
          uploaded && !summary.sample && allowed('upload') && { label: t('Upload new version…'), icon: 'upload', onClick: () => picker.current?.click() },
          // desktop has its Share button; the phone's strip has no room for it
          phone && allowed('share') && { label: t('Share…'), icon: 'link', onClick: onShare },
          'sep',
          canDownload && { label: t('Download V{v}', { v }), icon: 'download', onClick: () => void downloadVersion(slug, v) },
          canDownload && {
            sub: {
              label: t('Download another version'),
              icon: 'history',
              items: [...review.versions]
                .reverse()
                .filter((x) => x.v !== v)
                .map((x) => ({ label: versionWords(x), onClick: () => void downloadVersion(slug, x.v) })),
            },
          },
          'sep',
          { label: t('Export notes (PDF)'), icon: 'notes', onClick: () => window.open(`${location.pathname}#/print/${enc(slug)}`, '_blank') },
          !uploaded && { label: t('Copy file path'), icon: 'copy', onClick: async () => (await copyText(review.video)) && toast(t('Path copied'), 'ok') },
        ]}
      />
      {uploaded && (
        <input
          ref={picker}
          type="file"
          hidden
          accept={VIDEO_ACCEPT}
          data-testid="version-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            // The uploader (tus) loads only when it is used: local mode never needs it.
            import('../uploads/uploads.ts').then((m) => m.startUpload(file, { slug })).catch(toastError);
            toast(t('Uploading {name} as the next version', { name: file.name }), 'ok');
          }}
        />
      )}
    </div>
  );

  // Phones: back, the name with where it stands under it, the inbox and ⋯ in the bar; under it one strip that fits
  // without scrolling — the version, the quiet tools as icons, and the next step on the right. Sharing is in ⋯.
  if (phone)
    return (
      <>
        <div className="topbar grain p-bar">
          {back}
          <div className="p-title">
            <h1 className="ellipsis" title={review.video}>
              {fileName(review.video)}
            </h1>
            <span className="p-sub ellipsis">
              <StageLine info={data.summary.stage} />
              <span className="p-crumb">{review.folder ? crumbs(review.folder) : review.project}</span>
            </span>
          </div>
          {review.missing && <span className="badge danger">{t('missing')}</span>}
          {/* inbox */}
          <InboxBell />
          {more}
        </div>
        {strip ? (
          <div className="p-strip">{strip}</div>
        ) : (
          <div className="p-strip" role="toolbar" aria-label={t('Versions, compare and agent')}>
            {versions}
            {compare}
            {agent}
            <span className="grow" />
            {approval}
          </div>
        )}
      </>
    );
  return (
    <div className="topbar grain p-top">
      {back}
      {title}
      {versions}
      {review.missing && <span className="badge danger">{t('file missing')}</span>}
      <span className="grow" />
      <div className="p-tools">
        {compare}
        {agent}
        {share}
      </div>
      {approval}
      {/* inbox */}
      <InboxBell />
      {more}
    </div>
  );
});
