// What a project file is, as a glyph (the Files tab, its sheet, the check before an upload): Lucide (ISC), drawn like
// every icon of ui/icons.tsx (`strokeFor`, currentColor, decorative). A module of its own because only the Files
// screens use these: the start carries none of them (ui-rules.test.ts lets this file import Lucide too).
import { AudioLines, Clapperboard, FileArchive, FileIcon, FileText, ImageIcon, Layers, Shapes, TypeIcon } from 'lucide-react';
import type { FileKind } from '../../../lib/types.ts';
import { strokeFor } from './icons.tsx';

const KIND = {
  footage: Clapperboard,
  audio: AudioLines,
  image: ImageIcon,
  graphic: Shapes,
  font: TypeIcon,
  project: Layers,
  document: FileText,
  archive: FileArchive,
  other: FileIcon,
} satisfies Record<FileKind, unknown>;

export function KindIcon({ kind, size = 16, className = '' }: { kind: FileKind; size?: number; className?: string }) {
  const Glyph = KIND[kind] ?? FileIcon;
  return <Glyph className={`icon kind-${kind} ${className}`} size={size} strokeWidth={strokeFor(size)} aria-hidden={true} />;
}
