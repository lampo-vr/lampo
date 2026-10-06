// The design system's building blocks on top of the tokens in styles/base.css (styles/system.css draws them). One
// family per job, so a button, a chip or a card looks the same wherever it is: see #/styleguide for all of them.
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { EmptyArt, type EmptyArtName } from './emptyArt.tsx';
import { I, type IconName } from './icons.tsx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  icon?: IconName;
  /** Square; `aria-label` names it (IconButton adds the tooltip where there is room for one). */
  iconOnly?: boolean;
  /** A toggle that is on: the raised material, surface tone. */
  pressed?: boolean;
  /** The width of its container: the one action of a small card (a gate, a sheet's foot). */
  wide?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const ICON: Record<Size, number> = { sm: 14, md: 16, lg: 20 };

/** Primary (the raised ink, one per view), secondary (the default), ghost (toolbars, rows), danger (filled, for what
 * can't be undone), link (a text action: no box). Sizes follow the control heights: 26 · 30 · 40. A disabled primary
 * lies flat: the raised look means "you can press this". */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconOnly,
  pressed,
  wide,
  className = '',
  children,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const cls = [
    variant === 'link' ? 'btn-link' : 'btn',
    variant === 'primary' && 'primary',
    variant === 'ghost' && 'ghost',
    variant === 'danger' && 'danger-fill',
    variant !== 'link' && size !== 'md' && size,
    iconOnly && 'icon-only',
    pressed && 'on',
    wide && 'wide',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} aria-pressed={pressed === undefined ? undefined : pressed} {...rest}>
      {icon && <I name={icon} size={ICON[size]} />}
      {iconOnly ? null : children}
    </button>
  );
}

type ChipKind = 'tag' | 'count' | 'version' | 'key';

/** Small labels, all 20 px high with the same corners: a tag (sentence case), a count (tabular figures), a version
 * ("V9"), a key cap. Where a video stands is a Badge (with its keyframe glyph), not a chip. */
export function Chip({
  kind = 'tag',
  icon,
  children,
  title,
  className = '',
}: {
  kind?: ChipKind;
  icon?: IconName;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`ch ch-${kind} ${className}`} title={title}>
      {icon && <I name={icon} size={12} />}
      {children}
    </span>
  );
}

/** A surface: base (a card in a page), raised (a card on a card), floating (menus and dialogs cast a shadow). One
 * padding rule: md 16 (cards in a list), dense 12, lg 24 (a page's cards, dialogs). */
export function Panel({
  level = 'base',
  pad = 'md',
  as: Tag = 'section',
  className = '',
  children,
  ...rest
}: {
  level?: 'base' | 'raised' | 'floating';
  pad?: 'md' | 'dense' | 'lg' | 'none';
  as?: 'section' | 'div' | 'article';
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}) {
  return (
    <Tag className={`panel panel-${level} pad-${pad} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

/** A section's title: sentence case, 15 / 650, an optional count and actions on the right. No eyebrow. */
export function SectionHeader({
  title,
  count,
  actions,
  id,
  as: Tag = 'h2',
}: {
  title: ReactNode;
  count?: number | string | null;
  actions?: ReactNode;
  id?: string;
  as?: 'h2' | 'h3';
}) {
  return (
    <div className="section-head">
      <Tag id={id} className="section-title">
        {title}
      </Tag>
      {count != null && <span className="section-count">{count}</span>}
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

/** A page's head: an optional eyebrow (the one place for capitals), the title (36 / 650, no full stop) and what sits
 * across from it. */
export function PageHeader({ eyebrow, title, aside, meta }: { eyebrow?: ReactNode; title: ReactNode; aside?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-head">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <div className="page-head-row">
        <h1 className="page-title">{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
        {aside && <div className="page-aside">{aside}</div>}
      </div>
    </header>
  );
}

/** One row of a list: 40 px (dense 32), a leading visual, the text, trailing bits. */
export function ListRow({
  lead,
  title,
  sub,
  trail,
  dense,
  onClick,
  className = '',
}: {
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  trail?: ReactNode;
  dense?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      {lead && <span className="list-row-lead">{lead}</span>}
      <span className="list-row-text">
        <span className="list-row-title">{title}</span>
        {sub && <span className="list-row-sub">{sub}</span>}
      </span>
      {trail && <span className="list-row-trail">{trail}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`list-row ${dense ? 'dense' : ''} ${className}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`list-row ${dense ? 'dense' : ''} ${className}`}>{body}</div>
  );
}

/** Nothing to show, said well, as a place rather than a gap: a soft panel that takes the room of what it stands in for,
 * a small scene in the keyframe language (`art`), a headline without a full stop, one sentence, the one thing to do
 * about it (`action`: a primary Button; `secondary`: a quiet one beside it), a tip or two (`tips`: keys and dragging,
 * hidden on touch screens) and `foot`, a quiet line under it all. `sm` inside panels, lists and popovers. */
export function EmptyState({
  art,
  title,
  children,
  action,
  secondary,
  tips,
  foot,
  size = 'md',
  className = '',
  testId,
  titleAs: Title = 'p',
}: {
  art: EmptyArtName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  tips?: ReactNode[];
  foot?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  testId?: string;
  /** h2 where the empty state stands in for a page's content; h1 where it is the whole page (the server out of reach). */
  titleAs?: 'p' | 'h2' | 'h1';
}) {
  return (
    <div className={`empty-state ${size} ${className}`} data-testid={testId}>
      <EmptyArt name={art} />
      <Title className="empty-title">{title}</Title>
      {children && <p className="empty-body">{children}</p>}
      {(action || secondary) && (
        <div className="empty-action">
          {action}
          {secondary}
        </div>
      )}
      {!!tips?.length && (
        <ul className="empty-tips">
          {tips.map((tip, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of tips, never reordered
            <li key={i}>{tip}</li>
          ))}
        </ul>
      )}
      {foot && <p className="empty-foot">{foot}</p>}
    </div>
  );
}
