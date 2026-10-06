import { perLang, t } from '../i18n/index.ts';
import { Kbd, Modal } from '../ui/primitives.tsx';

const KEYS = perLang((): [string, string][] => [
  [t('Space'), t('play / pause')],
  ['J K L', t('reverse (press again: faster) · pause · play (again: faster)')],
  ['← →  ,  .', t('±1 frame (shift: ±10)')],
  [t('Home End'), t('first / last frame')],
  ['I  O', t('mark a section: its start / end on the frame on screen, also while playing (⇧: jump to it)')],
  [t('drag'), t('on the timeline’s notes lane (⇧ anywhere on it): mark a section, its note opens · drag its ends to adjust')],
  ['C  ↵', t('a note on this frame, or on the marked section · ⌘↵ sends · ⌘S keeps it as a draft · Esc cancels')],
  ['Esc  X', t('clear the marked section')],
  ['R', t('loop the marked section (or the whole video)')],
  ['M', t('mute')],
  ['⌘↵  ⇧⌘↵', t('notes not sent yet: send the one you are in · send them all')],
  ['1 2 3 4', t('while writing a note, outside its text: must · should · nice · idea')],
  ['#', t('in a note’s text: tag it (#timing, #sfx…)')],
  [t('hold T'), t('voice note: talk while it plays, release to pin it (written out and tagged)')],
  ['⇧R', t('record feedback: talk, point and draw while you watch; each thing you say becomes a draft note on its frame (⇧R again: done)')],
  ['D  ⇧D', t('next / previous change since the previous version')],
  ['⇧V', t('check mode: before and after for every fix · Y looks right · N still wrong · S skip')],
  ['[  ]', t('previous / next note')],
  ['↑  ↓', t('the note above / below in the list: it opens, the playhead on its frame')],
  ['N  ⇧N', t('walk through the open notes, one frame each · Esc leaves')],
  ['G', t('cycle safe-zone overlays')],
  ['V', t('phone view')],
  ['B', t('compare with another version: side by side · wipe · overlay (Esc closes)')],
  ['=  −  0', t('timeline zoom in / out / fit (or ⌘ + scroll; far in, every frame is a cell to click)')],
  ['Z  ⇧Z', t('zoom the timeline to the marked section (or around the playhead) · the whole video')],
]);

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('Keyboard')} onClose={onClose} width={520}>
      <div className="help-grid">
        {KEYS().map(([k, d]) => (
          <div key={k} style={{ display: 'contents' }}>
            <Kbd>{k}</Kbd>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
