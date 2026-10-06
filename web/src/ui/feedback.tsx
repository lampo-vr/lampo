// The spinner, for waits that have no shape (a button's own action). Anything with a layout gets a skeleton instead
// (ui/Skeleton.tsx); toasts live in ui/shell.tsx.
export const Spinner = ({ label }: { label?: string }) =>
  label ? <span className="spinner" role="status" aria-label={label} /> : <span className="spinner" aria-hidden="true" />;
