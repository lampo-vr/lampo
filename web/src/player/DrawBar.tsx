// The drawing tools while a note is written: a small dark bar on the picture, top centre — where you draw, not in the
// notes panel. The same bar for the owner's composer and the client's; it comes with the composer and goes with it.
import type { Tool } from '../api/types.ts';
import type { IconName } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import '../styles/drawbar.css';

export interface DrawTool {
  id: Tool;
  icon: IconName;
  label: string;
}

interface DrawBarProps {
  tools: DrawTool[];
  tool: Tool;
  /** Picks a tool (the client page turns a tool off by picking it again). */
  onTool: (t: Tool) => void;
  onUndo: () => void;
  canUndo: boolean;
  /** The toolbar's name, and Undo's. */
  label: string;
  undoLabel: string;
  /** Something else sits at the top of the picture (the compare bar): the tools go below it. */
  under?: boolean;
  /** A phone: flat in a strip of its own under the picture (the stage keeps the room), never over it. */
  flat?: boolean;
}

export function DrawBar({ tools, tool, onTool, onUndo, canUndo, label, undoLabel, under, flat }: DrawBarProps) {
  return (
    <div className="draw-layer">
      <div className={`draw-bar${under ? ' under' : ''}${flat ? ' flat' : ''}`} role="toolbar" aria-label={label} data-testid="draw-bar">
        {tools.map((x) => (
          <IconButton
            key={x.id}
            className={`btn sm ghost icon-only${tool === x.id ? ' on' : ''}`}
            label={x.label}
            icon={x.icon}
            size={20}
            side="bottom"
            onClick={() => onTool(x.id)}
            aria-pressed={tool === x.id}
          />
        ))}
        <span className="draw-sep" aria-hidden="true" />
        <IconButton className="btn sm ghost icon-only" label={undoLabel} icon="undo" size={20} side="bottom" onClick={onUndo} disabled={!canUndo} />
      </div>
    </div>
  );
}
