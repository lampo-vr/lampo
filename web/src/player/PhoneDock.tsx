// The transport on a phone: a readable timecode and thumb-sized steps (−10, −1, play, +1, +10) above the timeline,
// and everything else (in/out, loop, speed, sound, zoom, safe zones, phone view) in a strip that scrolls
// sideways under it. Same playback hook as the desktop transport, so stepping stays frame-exact.

import { useState } from 'react';
import { timecode } from '../../../lib/time.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Popover } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import { useFrame } from './frameStore.ts';
import { DEVICES } from './phone/devices.ts';
import { type PhoneView, viewChoice } from './phone/view.ts';
import { type Playback, RATES } from './usePlayback.ts';
import type { Preset } from './zones.ts';

export function PhoneTransport({ pb, fps, N }: { pb: Playback; fps: number; N: number }) {
  const { playing, revSpeed, rate } = pb;
  const frame = useFrame(pb.live);
  const running = playing || !!revSpeed;
  const step = (n: number) => pb.seek(Math.max(0, Math.min(N - 1, frame + n)));
  return (
    <div className="ptransport">
      <div className="ptc">
        <span className="main">{timecode(frame, fps)}</span>
        <span className="sub">
          F <b>{String(frame).padStart(4, '0')}</b> / {N - 1} · {Math.round(fps * 1000) / 1000} {t('fps')}
          {revSpeed ? ` · ◀ ${revSpeed}×` : rate !== 1 && playing ? ` · ${rate}×` : ''}
        </span>
        {pb.drift && <span className="badge warn">{t('shown f{shown}', { shown: pb.shown })}</span>}
      </div>
      <div className="pbtns">
        <button type="button" className="btn ghost pstep" onClick={() => step(-10)} aria-label={t('Back 10 frames')}>
          −10
        </button>
        <IconButton className="btn ghost pstep" label={t('Previous frame')} shortcut="←" icon="stepBack" size={20} onClick={() => step(-1)} />
        <IconButton
          className={`playbtn ${running ? 'playing' : ''}`}
          label={running ? t('Pause') : t('Play')}
          shortcut="Space"
          icon={running ? 'pause' : 'play'}
          size={20}
          onClick={() => (running ? pb.pause() : pb.play())}
        />
        <IconButton className="btn ghost pstep" label={t('Next frame')} shortcut="→" icon="stepFwd" size={20} onClick={() => step(1)} />
        <button type="button" className="btn ghost pstep" onClick={() => step(10)} aria-label={t('Forward 10 frames')}>
          +10
        </button>
      </div>
    </div>
  );
}

interface PhoneToolsProps {
  pb: Playback;
  fps: number;
  presets: Preset[];
  preset: Preset;
  onPreset: (id: string) => void;
  phone: PhoneView;
}

const zoom = (detail: 'in' | 'out' | 'fit') => window.dispatchEvent(new CustomEvent('vr-zoom', { detail }));

/** One row that fits a phone: in, out, loop, speed and sound where a thumb reaches them, quiet (no box around each), and
 * the rest — the in/out range, the timeline's zoom, safe zones, the phone view — behind More. It used to be one strip
 * of ten boxes that scrolled off the screen's edge. */
export function PhoneTools({ pb, fps, presets, preset, onPreset, phone }: PhoneToolsProps) {
  const { inPt, outPt, loop, muted, rate } = pb;
  const frame = useFrame(pb.live);
  const [more, setMore] = useState(false);
  const marked = inPt != null || outPt != null;
  // something behind More is switched on: the button says so, like a filter count
  const busy = marked || preset.id !== 'none' || !!phone.device;
  return (
    <div className="ptools" role="toolbar" aria-label={t('Playback tools')}>
      <button type="button" className={`btn ghost ${inPt != null ? 'on' : ''}`} onClick={() => pb.setIn(frame)} aria-label={t('Set in point')}>
        {t('In')}
      </button>
      <button type="button" className={`btn ghost ${outPt != null ? 'on' : ''}`} onClick={() => pb.setOut(frame)} aria-label={t('Set out point')}>
        {t('Out')}
      </button>
      <IconButton
        className={`btn ghost icon-only ${loop ? 'on' : ''}`}
        label={t('Loop')}
        shortcut="R"
        icon="loop"
        size={17}
        onClick={() => pb.setLoop((x) => !x)}
        aria-pressed={loop}
      />
      <Select
        label={t('Playback speed')}
        value={String(rate)}
        onChange={(r) => pb.setRate(Number(r))}
        options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
      />
      <IconButton
        className="btn ghost icon-only"
        label={muted ? t('Sound on') : t('Mute')}
        shortcut="M"
        icon={muted ? 'mute' : 'volume'}
        size={17}
        onClick={() => pb.setMuted((x) => !x)}
        aria-pressed={muted}
      />
      <span className="grow" />
      <Popover
        open={more}
        onOpenChange={setMore}
        className="ptools-pop"
        trigger={
          <button
            type="button"
            className={`btn ghost icon-only ptools-more ${more || busy ? 'on' : ''}`}
            aria-label={t('More playback tools')}
            data-testid="ptools-more"
          >
            <I name="more" size={17} />
          </button>
        }
      >
        <div className="pt-more">
          {marked && (
            <div className="pt-row">
              <span className="mono">
                {inPt != null ? timecode(inPt, fps) : '…'} → {outPt != null ? timecode(outPt, fps) : '…'}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  pb.setIn(null);
                  pb.setOut(null);
                }}
              >
                <I name="x" size={14} /> {t('Clear in and out')}
              </button>
            </div>
          )}
          <div className="pt-row">
            <span>{t('Timeline')}</span>
            <fieldset className="pt-group" aria-label={t('Timeline zoom')}>
              <IconButton className="btn icon-only" label={t('Zoom the timeline out')} icon="minus" onClick={() => zoom('out')} />
              <IconButton className="btn icon-only" label={t('Zoom the timeline in')} icon="plus" onClick={() => zoom('in')} />
              <button type="button" className="btn" onClick={() => zoom('fit')} aria-label={t('Fit the timeline')}>
                {t('Fit')}
              </button>
            </fieldset>
          </div>
          {/* the two choices as on the desktop, in its words: the safe zones (only the zones, over the picture), then the
              phone view (Off, Full height or an app's interface around the picture) and, while it is on, the phone */}
          <div className="pt-row">
            <span>{t('Safe zones')}</span>
            <Select
              label={t('Safe zones')}
              value={preset.id}
              onChange={onPreset}
              options={presets.map((p) => ({ value: p.id, label: p.id === 'none' ? t('Off') : p.label }))}
            />
          </div>
          <div className="pt-row">
            <span>{t('Phone view')}</span>
            <Select
              label={t('Phone view')}
              value={viewChoice(phone)}
              onChange={phone.onView}
              options={[
                { value: 'off', label: t('Off') },
                { value: 'full', label: t('Full height') },
                ...phone.apps.map((p) => ({ value: p.id, label: p.name ?? p.label })),
              ]}
            />
          </div>
          {phone.device && (
            <div className="pt-row">
              <span>{t('Phone')}</span>
              <Select label={t('Phone')} value={phone.device.id} onChange={phone.onDevice} options={DEVICES.map((d) => ({ value: d.id, label: d.label }))} />
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}
