// Icons: Lucide (ISC) behind one small API, `<I name="…" size={…} />`, so a glyph is chosen once, here, for the whole
// app. Names say what the icon is for, not what it shows. Stroke is 1.75 on the 24-unit grid at 18 px and above and a
// little heavier below, so small icons keep the same optical weight as large ones (≈1.2–1.3 px on screen).
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  AudioWaveform,
  Ban,
  Bell,
  Blend,
  BookOpenText,
  ChartColumn,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleHelp,
  CircleStop,
  Clock,
  Code,
  Columns2,
  Copy,
  CreditCard,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Globe,
  Grid3x3,
  Hash,
  Heart,
  History,
  ImageIcon,
  Inbox,
  Info,
  Kanban,
  KeyRound,
  Languages,
  Layers,
  LayoutGrid,
  Link,
  Link2Off,
  List,
  ListFilter,
  ListVideo,
  Lock,
  LockOpen,
  LogOut,
  type LucideIcon,
  Mail,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquareText,
  Mic,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  MoveUpRight,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  QrCode,
  RefreshCw,
  Repeat,
  Reply,
  RotateCcw,
  Scan,
  ScanSearch,
  Search,
  Send,
  Settings,
  Shield,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Smartphone,
  Snowflake,
  Sparkle,
  SpellCheck,
  Square,
  SquarePen,
  SquareSplitHorizontal,
  SquareTerminal,
  StepBack,
  StepForward,
  Sun,
  Terminal,
  Trash2,
  Undo2,
  Upload,
  User,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { AgentKind } from '../../../lib/types.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { AGENT_MARKS } from './agentMarks.ts';
import { BRAND_NAME, FRAME_EXIT, FRAME_RING, FRAME_WINDOW, LOGO_LETTERS, LOGO_VIEWBOX, MARK_VIEWBOX } from './brandMark.ts';

// `fill`: solid glyphs (transport play/pause read as buttons of a deck, not outlines).
const P = {
  // transport
  heart: { icon: Heart },
  play: { icon: Play, fill: true },
  pause: { icon: Pause, fill: true },
  stepBack: { icon: StepBack },
  stepFwd: { icon: StepForward },
  first: { icon: SkipBack },
  last: { icon: SkipForward },
  loop: { icon: Repeat },
  volume: { icon: Volume2 },
  mute: { icon: VolumeX },
  // player tools and views
  phone: { icon: Smartphone },
  layers: { icon: Layers },
  compare: { icon: SquareSplitHorizontal },
  columns: { icon: Columns2 },
  mic: { icon: Mic },
  stop: { icon: CircleStop },
  record: { icon: Circle, fill: true },
  tag: { icon: Hash },
  box: { icon: Square },
  arrow: { icon: MoveUpRight },
  pen: { icon: Pencil },
  pointer: { icon: MousePointer2 },
  undo: { icon: Undo2 },
  wave: { icon: AudioWaveform },
  freeze: { icon: Snowflake },
  eye: { icon: Eye },
  eyeOff: { icon: EyeOff },
  swap: { icon: ArrowLeftRight },
  blend: { icon: Blend },
  reviewMode: { icon: ListVideo },
  // actions
  trash: { icon: Trash2 },
  check: { icon: Check },
  fixed: { icon: CircleCheck },
  verified: { icon: CheckCheck },
  wontfix: { icon: Ban },
  reopen: { icon: RotateCcw },
  x: { icon: X },
  plus: { icon: Plus },
  minus: { icon: Minus },
  // the timeline's zoom
  zoomIn: { icon: ZoomIn },
  zoomOut: { icon: ZoomOut },
  copy: { icon: Copy },
  edit: { icon: SquarePen },
  reply: { icon: Reply },
  refresh: { icon: RefreshCw },
  more: { icon: Ellipsis },
  search: { icon: Search },
  link: { icon: Link },
  // a link that can’t be used any more (the entrance: a review link or an emailed link that ended)
  unlink: { icon: Link2Off },
  // an email on its way (the entrance: Check your inbox)
  mail: { icon: Mail },
  image: { icon: ImageIcon },
  attach: { icon: Paperclip },
  external: { icon: ExternalLink },
  expand: { icon: Maximize2 },
  send: { icon: Send },
  archive: { icon: Archive },
  restore: { icon: ArchiveRestore },
  upload: { icon: Upload },
  download: { icon: Download },
  qr: { icon: QrCode },
  // navigation
  back: { icon: ChevronLeft },
  right: { icon: ChevronRight },
  down: { icon: ChevronDown },
  sortAsc: { icon: ArrowUp },
  sortDesc: { icon: ArrowDown },
  sortable: { icon: ChevronsUpDown },
  menu: { icon: Menu },
  display: { icon: SlidersHorizontal },
  filter: { icon: ListFilter },
  // places and things
  folder: { icon: Folder },
  folderOpen: { icon: FolderOpen },
  folderPlus: { icon: FolderPlus },
  moveTo: { icon: FolderInput },
  film: { icon: Film },
  notes: { icon: MessageSquareText },
  inbox: { icon: Inbox },
  playbook: { icon: BookOpenText },
  history: { icon: History },
  bell: { icon: Bell },
  chart: { icon: ChartColumn },
  grid: { icon: LayoutGrid },
  compact: { icon: Grid3x3 },
  list: { icon: List },
  board: { icon: Kanban },
  help: { icon: CircleHelp },
  info: { icon: Info },
  terminal: { icon: SquareTerminal },
  // a command to type (the entrance: Sign in an agent)
  command: { icon: Terminal },
  // agents to connect (Settings → Connect an agent): an editor, a chat app, anything else that speaks MCP
  editor: { icon: Code },
  chat: { icon: MessageCircle },
  plug: { icon: Plug },
  // the agent's mark (Claude sessions, agent notes, "Ask Claude")
  spark: { icon: Sparkle },
  autoCheck: { icon: ScanSearch },
  typo: { icon: SpellCheck },
  safeZone: { icon: Scan },
  flash: { icon: Zap },
  blackFrame: { icon: Square, fill: true },
  lock: { icon: Lock },
  // a lock taken off again (a suspended workspace lifted)
  unlock: { icon: LockOpen },
  // review links anyone can open (the share dialog's reach)
  globe: { icon: Globe },
  clock: { icon: Clock },
  user: { icon: User },
  users: { icon: Users },
  key: { icon: KeyRound },
  // what a workspace pays (Settings → Billing, where a billing provider runs)
  billing: { icon: CreditCard },
  signOut: { icon: LogOut },
  shield: { icon: Shield },
  settings: { icon: Settings },
  sun: { icon: Sun },
  moon: { icon: Moon },
  system: { icon: Monitor },
  language: { icon: Languages },
} satisfies Record<string, { icon: LucideIcon; fill?: boolean }>;

export type IconName = keyof typeof P;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/** Stroke on the 24-unit grid for an icon drawn at `size` px: the same optical weight at every size. */
export const strokeFor = (size: number) => (size >= 18 ? 1.75 : size >= 16 ? 1.9 : size >= 14 ? 2 : size >= 12 ? 2.25 : 2.5);

export function I({ name, size = 18, className = '', style, title }: IconProps) {
  const def: { icon: LucideIcon; fill?: boolean } = P[name];
  const Glyph = def.icon;
  return (
    <Glyph
      className={`icon i-${name} ${className}`}
      size={size}
      strokeWidth={strokeFor(size)}
      fill={def.fill ? 'currentColor' : 'none'}
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  );
}

const logosCode = loader(() => import('./agentLogos.ts'));

/**
 * Which agent it is (ui/agentMarks.ts): its company's mark, a monogram tile, or a glyph, in the text colour. Decorative:
 * the agent's name stands next to it. No kind (a list from an older server) reads as an unknown MCP client.
 */
export function AgentMark({ kind, size = 16 }: { kind: AgentKind | null | undefined; size?: number }) {
  const k = kind ?? 'mcp';
  const def = AGENT_MARKS[k] ?? AGENT_MARKS.mcp;
  // a company's mark arrives a moment after the first paint (ui/agentLogos.ts); its box is there from the start
  const logos = useLoaded(logosCode, def.type === 'logo');
  const cls = `icon agent-mark am-${k}`;
  if (def.type === 'glyph') return <I name={def.icon} size={size} className={cls} />;
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" data-agent={k}>
      {def.type === 'logo' ? (
        logos && <path d={logos.AGENT_LOGOS[def.logo]} fill="currentColor" />
      ) : (
        <>
          <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <text
            x="12"
            y="12.5"
            textAnchor="middle"
            dominantBaseline="central"
            fill="currentColor"
            fontSize={def.letters.length > 2 ? 8.5 : 10.5}
            fontWeight={650}
            letterSpacing={def.letters.length > 2 ? -0.3 : 0}
          >
            {def.letters}
          </text>
        </>
      )}
    </svg>
  );
}

// The brand (ui/brandMark.ts): the lettering and the frame o take the text colour (currentColor), so they follow the
// theme; the frame's window is the one brand colour (.brand-window → --brand).

/** The mark alone: the frame o, optically centred in its square (the client player's top bar). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox={MARK_VIEWBOX} aria-hidden="true">
      <path className="brand-window" d={FRAME_WINDOW} />
      <path d={FRAME_RING} fill="currentColor" fillRule="evenodd" />
      <path d={FRAME_EXIT} fill="currentColor" />
    </svg>
  );
}

/** The logo, "lampo" with the frame o, as the header, sign-in and client pages show it. It names its link. */
export function Wordmark() {
  return (
    <svg className="brand-logo" viewBox={LOGO_VIEWBOX} role="img" aria-label={BRAND_NAME}>
      <path className="brand-window" d={FRAME_WINDOW} />
      <path d={LOGO_LETTERS} fill="currentColor" />
      <path d={FRAME_RING} fill="currentColor" fillRule="evenodd" />
      <path d={FRAME_EXIT} fill="currentColor" />
    </svg>
  );
}
