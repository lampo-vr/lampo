// The phone view as one choice: Off, Full height, or an app whose interface it draws around the picture (its own pref,
// vr.player `phoneApp`: playerPrefs.ts), on the phone picked last. It draws no zones: those are the safe zones' menu's,
// which draws them over the picture with the phone view on or off. The desktop transport shows it as one menu, a real
// phone in its tools' More.
import type { Preset } from '../zones.ts';
import type { Device } from './devices.ts';

export interface PhoneView {
  /** The phone shown, or null while the view is off. */
  device: Device | null;
  /** The phone picked last: what V brings back. */
  model: Device;
  /** The app the picture is shown in, as its preset (`app`, `name`); null = Full height. */
  app: Preset | null;
  /** The apps this video can be shown in (vertical and square videos). */
  apps: Preset[];
  /** 'off', 'full' or an app's preset id. */
  onView: (choice: string) => void;
  /** Shows the view on this phone (turning it on). */
  onDevice: (id: string) => void;
}

/** What the view shows now, as onView takes it. */
export const viewChoice = (pv: PhoneView): string => (!pv.device ? 'off' : pv.app ? pv.app.id : 'full');
