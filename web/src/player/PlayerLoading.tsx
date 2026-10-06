// The player while its review loads: the same page with its real parts idle — the top bar (the name on its way), the
// stage (dark: no picture is invented), the transport, the timeline and the dock foot at the sizes they will have, and
// the notes panel with its tabs — so nothing moves when the review arrives.
import { type CSSProperties, useState } from 'react';
import { t } from '../i18n/index.ts';
import { InboxBell } from '../inbox/InboxBell.tsx';
import { backToLibrary } from '../lib/nav.ts';
import { usePrefs } from '../lib/prefs.ts';
import { I } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { createFrameStore } from './frameStore.ts';
import { NotesPanel } from './NotesPanel.tsx';
import { PhoneTools, PhoneTransport } from './PhoneDock.tsx';
import { deviceById } from './phone/devices.ts';
import type { PhoneView } from './phone/view.ts';
import Timeline from './Timeline.tsx';
import { Transport } from './Transport.tsx';
import type { Playback } from './usePlayback.ts';
import { presetById, presetsFor } from './zones.ts';

const noop = () => {};
const NO_TRANSCRIPT = { base: null, onSeek: noop, onPlay: noop, edits: [] };

/** Nothing loaded, nothing playing: what the transport shows before there is a video. */
const IDLE: Playback = {
  setVideo: noop,
  setB: noop,
  videoRef: { current: null },
  frame: 0,
  frameRef: { current: 0 },
  live: createFrameStore(0),
  shown: null,
  drift: false,
  playing: false,
  rate: 1,
  setRate: noop,
  muted: false,
  setMuted: noop,
  loop: false,
  setLoop: noop,
  inPt: null,
  setIn: noop,
  outPt: null,
  setOut: noop,
  revSpeed: 0,
  src: '',
  seek: noop,
  play: noop,
  pause: noop,
  startReverse: noop,
  playSegments: noop,
  rangeLoop: null,
};

interface Props {
  /** The video: the transcript tab comes back only on the video it was open on (Player.tsx). */
  slug: string;
  phone: boolean;
  /** Height / width of the video when the library already said (tablets size the stage by it). */
  ar?: number;
}

export function PlayerLoading({ slug, phone, ar }: Props) {
  const presets = presetsFor(1920, 1080);
  // the tab you worked in last, as the loaded player will show it
  const [prefs] = usePrefs('vr.player');
  const preset = presetById('none');
  // the timeline's zoom in the transport row, as in the loaded player
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  // the phone view as the loaded player will name it (its app is the preset of the video's shape, when the library said)
  const tall = ar != null && ar > 1.05;
  const app = presetById(tall ? prefs['preset.vertical'] : undefined);
  const phoneView: PhoneView = {
    device: prefs.phone ? deviceById(prefs.device) : null,
    model: deviceById(prefs.device),
    app: app.app ? app : null,
    apps: [],
    zones: false,
    onView: noop,
    onDevice: noop,
    onZones: noop,
  };
  const back = <IconButton className="btn ghost sm icon-only" label={t('Back to the library')} icon="back" size={17} onClick={backToLibrary} side="bottom" />;
  const more = <IconButton className="btn sm icon-only ghost" label={t('More')} icon="more" side="bottom" aria-disabled />;
  const title = (
    <div className="p-title">
      <h1 className="ellipsis">
        <SkLine w="12em" />
      </h1>
      <span className="ellipsis">
        <SkLine w="7em" />
      </span>
    </div>
  );
  return (
    <main
      className={phone ? 'player phone-player ps-peek' : 'player'}
      style={ar ? ({ '--ar': ar } as CSSProperties) : undefined}
      aria-busy="true"
      aria-label={t('Loading the player')}
    >
      {phone ? (
        <>
          <div className="topbar grain p-bar">
            {back}
            {title}
            <InboxBell />
            {more}
          </div>
          <div className="p-strip" inert>
            <span className="vpick">
              <SkLine w="1.6em" />
            </span>
            <button type="button" className="btn sm ghost">
              <I name="compare" size={15} /> {t('Compare')}
            </button>
          </div>
        </>
      ) : (
        <div className="topbar grain p-top">
          {back}
          {title}
          <span className="vpick">
            <SkLine w="1.6em" />
          </span>
          <span className="grow" />
          <InboxBell />
          {more}
        </div>
      )}
      <div className="stage" />
      <div className="dock grain" inert>
        {phone ? (
          <PhoneTransport pb={IDLE} fps={25} N={1} />
        ) : (
          <Transport
            pb={IDLE}
            fps={25}
            N={1}
            srcMap={null}
            srcFile={null}
            presets={presets}
            preset={preset}
            onPreset={noop}
            phone={phoneView}
            zoomSlot={setZoomSlot}
          />
        )}
        <Timeline frames={1} fps={25} frame={0} onSeek={noop} selected={null} onSelect={noop} zoomAt={phone ? undefined : zoomSlot} />
        {phone && <PhoneTools pb={IDLE} fps={25} presets={presets} preset={preset} onPreset={noop} phone={phoneView} />}
        <div className="dock-foot" />
      </div>
      <NotesPanel
        slug=""
        videoName=""
        v={1}
        latestV={1}
        frame={0}
        filter="active"
        setFilter={noop}
        counts={null}
        list={[]}
        selected={null}
        onSelect={noop}
        onLightbox={noop}
        canCompose={false}
        onCompose={noop}
        verifyCount={0}
        verifying={false}
        onVerify={noop}
        onReview={noop}
        reviewing={false}
        autoCheck={null}
        composer={null}
        sheet={phone ? { state: 'peek', setState: noop } : undefined}
        view={prefs.panel === slug ? 'transcript' : 'notes'}
        setView={noop}
        transcript={NO_TRANSCRIPT}
      />
    </main>
  );
}
