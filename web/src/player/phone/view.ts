// The phone view as one choice: Off, Full height, or an app — the app being the vertical safe-zone preset (zones.ts
// `app`), so the phone and the safe zones can never disagree — plus the phone it is shown on and whether the preset's
// zones are drawn over the app. The desktop transport shows it as one menu, a real phone in its tools' More.
import type { Preset } from '../zones.ts';
import type { Device } from './devices.ts';

export interface PhoneView {
  /** The phone shown, or null while the view is off. */
  device: Device | null;
  /** The phone picked last: what V brings back. */
  model: Device;
  /** The app the picture is shown in (the preset, when it is an app); null = Full height. */
  app: Preset | null;
  /** The apps this video can be shown in (vertical and square videos). */
  apps: Preset[];
  /** The preset's zones over the app ("Show safe zones"). */
  zones: boolean;
  /** 'off', 'full' or an app's preset id. */
  onView: (choice: string) => void;
  /** Shows the view on this phone (turning it on). */
  onDevice: (id: string) => void;
  onZones: () => void;
}

/** What the view shows now, as onView takes it. */
export const viewChoice = (pv: PhoneView): string => (!pv.device ? 'off' : pv.app ? pv.app.id : 'full');
