// Draws a safe-zone preset (zones.ts) over the picture: its zones, labelled, or the rule of thirds. Only the zones: an
// app's interface is the phone view's (phone/PhoneArt.tsx), and in the phone view these lie over it, on the picture as
// the phone shows it — there without their words: the interface shows what each zone is for, and the words would sit on
// its buttons and caption.
import { type Preset, ZONES, type Zone } from './zones.ts';

const FONT = '-apple-system, system-ui, sans-serif';

function Zones({ zones, cw, labels }: { zones: Zone[]; cw: number; labels: boolean }) {
  const k = cw / 1080; // stroke/label scale relative to a 1080-wide canvas
  return (
    <g>
      <defs>
        <pattern id="ovHatch" width={16 * k} height={16 * k} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={16 * k} height={16 * k} fill="rgba(255,60,90,0.16)" />
          <line x1="0" y1="0" x2="0" y2={16 * k} stroke="rgba(255,60,90,0.5)" strokeWidth={5 * k} />
        </pattern>
      </defs>
      {zones.map((z) =>
        z.type === 'unsafe' ? (
          <g key={`${z.x},${z.y},${z.w},${z.h}`}>
            <rect data-zone={z.type} x={z.x} y={z.y} width={z.w} height={z.h} fill="url(#ovHatch)" />
            {labels && z.label && <Label x={z.x + z.w / 2} y={z.y + z.h / 2} k={k} text={z.label} />}
          </g>
        ) : (
          <g key={`${z.x},${z.y},${z.w},${z.h}`}>
            <rect
              data-zone={z.type}
              x={z.x}
              y={z.y}
              width={z.w}
              height={z.h}
              rx={8 * k}
              fill="none"
              stroke="rgba(255,255,255,0.7)"
              strokeWidth={3 * k}
              strokeDasharray={`${14 * k} ${10 * k}`}
            />
            {labels && z.label && <Label x={z.x + 12 * k} y={z.labelAt === 'bottom' ? z.y + z.h - 28 * k : z.y + 30 * k} k={k} text={z.label} anchor="start" />}
          </g>
        ),
      )}
    </g>
  );
}

const Label = ({ x, y, k, text, anchor = 'middle' }: { x: number; y: number; k: number; text: string; anchor?: 'middle' | 'start' }) => (
  <text
    x={x}
    y={y}
    textAnchor={anchor}
    dominantBaseline="middle"
    fill="#fff"
    fontSize={24 * k}
    fontWeight="600"
    fontFamily={FONT}
    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 5 * k }}
  >
    {text}
  </text>
);

function Thirds({ w, h }: { w: number; h: number }) {
  const sw = Math.max(1.5, Math.min(w, h) / 400);
  return (
    <g stroke="rgba(255,255,255,0.55)" strokeWidth={sw} fill="none">
      <line x1={w / 3} y1="0" x2={w / 3} y2={h} />
      <line x1={(2 * w) / 3} y1="0" x2={(2 * w) / 3} y2={h} />
      <line x1="0" y1={h / 3} x2={w} y2={h / 3} />
      <line x1="0" y1={(2 * h) / 3} x2={w} y2={(2 * h) / 3} />
      <path d={`M${w / 2 - w * 0.025} ${h / 2}h${w * 0.05}M${w / 2} ${h / 2 - w * 0.025}v${w * 0.05}`} strokeWidth={sw * 1.4} />
    </g>
  );
}

// Rendered on top of the canvas box (preset canvas or video box). `size` = [w, h] of that coordinate system; `labels`
// off over an app's interface.
export default function Overlay({ preset, size, labels = true }: { preset: Preset | null; size: [number, number]; labels?: boolean }) {
  if (!preset || preset.id === 'none') return null;
  const [w, h] = size;
  return (
    <svg className="ig-layer" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" data-preset={preset.id}>
      {preset.id === 'thirds' && <Thirds w={w} h={h} />}
      {ZONES()[preset.id] && <Zones zones={ZONES()[preset.id]} cw={Math.min(w, h)} labels={labels} />}
    </svg>
  );
}
