// Transport row: step/play, timecode (hover: source clip), in/out, loop, speed, mute; the timeline's zoom; safe zones,
// phone view — two choices, each drawing one thing: the zones over the picture, the phone and an app's interface around
// it. One row at desktop widths: the marked section shows on the timeline, not here, and labels fold to their icons
// (the zoom's level too, where the row is short).

import type { Ref } from 'react';
import { timecode } from '../../../lib/time.ts';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu, type MenuEntry, Tip } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import { useFrame } from './frameStore.ts';
import { DEVICES } from './phone/devices.ts';
import type { PhoneView } from './phone/view.ts';
import { phoneArt } from './Stage.tsx';
import { type Playback, RATES } from './usePlayback.ts';
import type { Preset } from './zones.ts';

interface TransportProps {
  pb: Playback;
  fps: number;
  N: number;
  srcMap: string | null;
  srcFile: string | null;
  presets: Preset[];
  preset: Preset;
  onPreset: (id: string) => void;
  phone: PhoneView;
  /** I / O from the buttons, as the keys do them (an in after the out starts a new section). */
  onIn?: (f: number) => void;
  onOut?: (f: number) => void;
  /** Where the timeline puts its zoom control (Timeline.tsx `zoomAt`): beside the speed and the sound. */
  zoomSlot?: Ref<HTMLDivElement>;
}

/** "Phone view: TikTok · iPhone 15 / 16", or null while it is off. */
export const phoneViewName = (phone: PhoneView) =>
  phone.device ? t('Phone view: {view} · {device}', { view: phone.app?.name ?? t('Full height'), device: phone.device.label }) : null;

export function Transport({ pb, fps, N, srcMap, srcFile, presets, preset, onPreset, phone, onIn, onOut, zoomSlot }: TransportProps) {
  const { playing, revSpeed, rate, inPt, outPt, loop, muted } = pb;
  const frame = useFrame(pb.live);
  const running = playing || !!revSpeed;
  const phoneName = phoneViewName(phone);
  const phoneWord = phone.device ? (phone.app?.name ?? t('Full height')) : t('Phone');
  const phoneWords = [t('Phone'), t('Full height'), ...phone.apps.map((p) => p.name ?? p.label)];
  const zonesName = preset.id === 'none' ? t('Safe zones: off') : t('Safe zones: {preset}', { preset: preset.label });
  const zonesWord = preset.id === 'none' ? t('Safe zones: off') : preset.label;
  const zonesWords = presets.map((p) => (p.id === 'none' ? t('Safe zones: off') : p.label));
  return (
    <div className="transport">
      <div className="group">
        <IconButton className="btn sm icon-only ghost tr-edge" label={t('First frame')} shortcut="Home" icon="first" onClick={() => pb.seek(0)} />
        <IconButton
          className="btn sm icon-only ghost"
          label={t('Previous frame')}
          tip={t('Previous frame (⇧ 10 back)')}
          shortcut="←"
          icon="stepBack"
          onClick={() => pb.seek(frame - 1)}
        />
        <IconButton
          className={`playbtn ${running ? 'playing' : ''}`}
          label={running ? t('Pause') : t('Play')}
          tip={running ? t('Pause') : t('Play (J K L: reverse, pause, faster)')}
          shortcut="Space"
          icon={running ? 'pause' : 'play'}
          size={16}
          onClick={() => (running ? pb.pause() : pb.play())}
        />
        <IconButton
          className="btn sm icon-only ghost"
          label={t('Next frame')}
          tip={t('Next frame (⇧ 10 ahead)')}
          shortcut="→"
          icon="stepFwd"
          onClick={() => pb.seek(frame + 1)}
        />
        <IconButton className="btn sm icon-only ghost tr-edge" label={t('Last frame')} shortcut="End" icon="last" onClick={() => pb.seek(N - 1)} />
        <div className="tc">
          <Tip
            content={
              srcMap ? (srcFile ? t('Source clip {clip} (from {file})', { clip: srcMap, file: srcFile }) : t('Source clip {clip}', { clip: srcMap })) : null
            }
          >
            <span className="main">{timecode(frame, fps)}</span>
          </Tip>
          <span className="sub">
            <span>
              F <b>{String(frame).padStart(4, '0')}</b> / {N - 1}
            </span>
            <span>
              <b>{Math.round(fps * 1000) / 1000}</b> {t('FPS')}
              {revSpeed ? ` · ◀ ${revSpeed}×` : rate !== 1 && playing ? ` · ${rate}×` : ''}
            </span>
          </span>
          {pb.drift && (
            <Tip content={t('The browser reports a different presented frame than requested')}>
              <span className="badge warn">{t('shown f{shown}', { shown: pb.shown })}</span>
            </Tip>
          )}
        </div>
        <div className="vsep" />
        {/* The section's start and end: quiet until set, then on (the section itself, its times and what to do with it,
            is the chip on the timeline) — so the row never grows or wraps when one is marked. */}
        <Tip content={inPt != null ? t('Start {tc} · I: here · ⇧I: go there', { tc: timecode(inPt, fps) }) : t('Mark the section’s start here')} shortcut="I">
          <button
            type="button"
            className={`btn sm ghost tr-mark ${inPt != null ? 'on' : ''}`}
            onClick={() => (onIn ? onIn(frame) : pb.setIn(frame))}
            aria-label={t('Set in')}
            aria-pressed={inPt != null}
            data-testid="mark-in"
          >
            I
          </button>
        </Tip>
        <Tip content={outPt != null ? t('End {tc} · O: here · ⇧O: go there', { tc: timecode(outPt, fps) }) : t('Mark the section’s end here')} shortcut="O">
          <button
            type="button"
            className={`btn sm ghost tr-mark ${outPt != null ? 'on' : ''}`}
            onClick={() => (onOut ? onOut(frame) : pb.setOut(frame))}
            aria-label={t('Set out')}
            aria-pressed={outPt != null}
            data-testid="mark-out"
          >
            O
          </button>
        </Tip>
        <IconButton
          className={`btn sm ghost icon-only ${loop ? 'on' : ''}`}
          label={t('Loop')}
          tip={t('Loop the marked section, or the whole video')}
          shortcut="R"
          icon="loop"
          size={15}
          onClick={() => pb.setLoop((x) => !x)}
          aria-pressed={loop}
        />
        <Select
          label={t('Playback speed')}
          title={t('Playback speed')}
          size="sm"
          value={String(rate)}
          onChange={(r) => pb.setRate(Number(r))}
          options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
        />
        <IconButton
          className="btn sm icon-only ghost"
          label={muted ? t('Unmute') : t('Mute')}
          shortcut="M"
          icon={muted ? 'mute' : 'volume'}
          onClick={() => pb.setMuted((x) => !x)}
          aria-pressed={muted}
        />
      </div>
      {/* the timeline's zoom (ZoomControl.tsx, rendered here by the timeline): its own group, so a short row moves the
          menus on the right to a line of their own before anything of the playback's has to */}
      {zoomSlot && (
        <div className="group tr-zoom">
          <div className="vsep" />
          <div className="tr-zoom-slot" ref={zoomSlot} />
        </div>
      )}
      <div className="group right">
        {/* the safe zones: a menu behind one button, its words folding to the icon where the row is short. It draws only
            the zones (the stripes, the guides), with the phone view on or off — there on the picture as the phone shows
            it; an app's interface is the phone view's own choice, beside it. */}
        <Menu
          align="end"
          trigger={
            <Tip content={zonesName} shortcut="G">
              <button type="button" className={`btn sm ghost tr-safe ${preset.id !== 'none' ? 'on' : ''}`} aria-label={zonesName} data-testid="safe-zones">
                <I name="safeZone" size={15} />
                {/* as wide as its longest word: G and the menu never move the buttons around it */}
                <Stack words={zonesWords} word={zonesWord} />
                <I name="down" size={12} className="tr-chev" />
              </button>
            </Tip>
          }
          items={zoneItems(presets, preset, onPreset)}
        />
        {/* the phone view: one menu — Off, Full height (the video on the whole screen) or an app's interface around it
            (its icons, buttons, caption and tab bar; no zones: those are the menu beside it), then the phone to show it
            on (V turns the last choice on and off). Picking anything turns the view on, so nothing appears beside the
            button and the row never moves. */}
        <Menu
          align="end"
          onOpenChange={(open) => open && phoneArt.load()}
          trigger={
            <Tip content={phoneName ?? t('Phone view at real size')} shortcut="V">
              <button
                type="button"
                className={`btn sm ghost tr-safe ${phone.device ? 'on' : ''}`}
                aria-label={phoneName ?? t('Phone view')}
                data-testid="device"
              >
                <I name="phone" size={15} />
                {/* as wide as its longest word: switching the view (V, the menu) never moves the button beside it */}
                <Stack words={phoneWords} word={phoneWord} />
                <I name="down" size={12} className="tr-chev" />
              </button>
            </Tip>
          }
          items={phoneItems(phone)}
        />
      </div>
    </div>
  );
}

/** A label as wide as its longest word: the others lie hidden in the same cell, so a new choice never moves the row. */
function Stack({ words, word }: { words: string[]; word: string }) {
  return (
    <span className="lbl tr-stack">
      {[...new Set(words)].map((w) => (
        <span key={w} className={w === word ? undefined : 'ghost'} aria-hidden={w === word ? undefined : true}>
          {w}
        </span>
      ))}
    </span>
  );
}

/** The safe zones' menu: Off, then the presets this video's shape has. Headed like the phone's, so the two read apart. */
function zoneItems(presets: Preset[], preset: Preset, onPreset: (id: string) => void): MenuEntry[] {
  return [
    { heading: t('Safe zones') },
    ...presets.map((p) => ({ label: p.id === 'none' ? t('Off') : p.label, checked: p.id === preset.id, onClick: () => onPreset(p.id) })),
  ];
}

/** The phone view's menu: what the phone shows (Off, Full height or an app's interface), then which phone. */
export function phoneItems(phone: PhoneView): MenuEntry[] {
  const on = !!phone.device;
  return [
    { heading: t('Phone view') },
    { label: t('Off'), checked: !on, onClick: () => phone.onView('off') },
    { label: t('Full height'), checked: on && !phone.app, onClick: () => phone.onView('full') },
    ...phone.apps.map((p) => ({ label: p.name ?? p.label, checked: on && phone.app?.id === p.id, onClick: () => phone.onView(p.id) })),
    'sep',
    { heading: t('Phone') },
    ...DEVICES.map((d) => ({ label: d.label, checked: d.id === phone.model.id, onClick: () => phone.onDevice(d.id) })),
  ];
}
