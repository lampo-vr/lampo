// The fields and the way in of every form in front of the app: a review link's password gate (guest/Gate.tsx), the
// owner's setup, sign-in, sign-up, confirm and reset (auth/), an invite, the new-workspace dialog. One set of parts, so
// the two sides can't drift apart: a label over a boxed field, an eye in every password, helper text under its field,
// one line kept for what went wrong (a miss shakes the field it is about and moves the cursor there), and the orange
// way in — never grey while the form is empty: a press says what is missing instead. Styles: styles/entry-form.css.
import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, useId, useState } from 'react';
import { t } from '../i18n/index.ts';
import { Spinner } from './feedback.tsx';
import { I } from './icons.tsx';
import '../styles/entry-form.css';

/** Two names for one shake, taking turns: every miss plays it again. */
export type Shake = 'a' | 'b';

export interface EntryFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: ReactNode;
  value: string;
  /** What helps fill it in, under the field. */
  hint?: ReactNode;
  /** A way out beside the label ("Forgot password?", a "?"), after the field in the tab order. */
  aside?: ReactNode;
  /** What went wrong is about this field: its border says so. */
  bad?: boolean;
  /** Set on a miss about this field: it shakes. */
  shake?: Shake;
  inputRef?: Ref<HTMLInputElement>;
  /** The monospaced face (a token). */
  mono?: boolean;
  /** Inside the field, at its end (PasswordField's eye). */
  trailing?: ReactNode;
}

export function EntryField({ label, hint, aside, bad: told, shake, inputRef, mono, trailing, id: given, ...input }: EntryFieldProps) {
  const own = useId();
  const id = given ?? own;
  // a miss that shakes this field is about it: its border says so too, while it is said
  const bad = told || !!shake;
  const hintId = hint ? `${id}-hint` : undefined;
  const described = [input['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="entry-field">
      <label className="inv-label" htmlFor={id}>
        {label}
      </label>
      <div className={`inv-field${bad ? ' bad' : ''}${trailing ? ' with-eye' : ''}`} data-shake={shake}>
        <input
          {...input}
          ref={inputRef}
          id={id}
          className={`gate-input${mono ? ' mono' : ''}`}
          aria-invalid={bad || input['aria-invalid'] || undefined}
          aria-describedby={described}
        />
        {trailing}
      </div>
      {/* beside the label on screen, after the field (and its eye) for Tab */}
      {aside && <span className="entry-aside">{aside}</span>}
      {hint && (
        <div id={hintId} className="entry-hint">
          {hint}
        </div>
      )}
    </div>
  );
}

/** A password: the field with an eye that shows what was typed (and hides it again). */
export function PasswordField({ showLabel, hideLabel, ...props }: Omit<EntryFieldProps, 'type' | 'trailing'> & { showLabel?: string; hideLabel?: string }) {
  const [show, setShow] = useState(false);
  return (
    <EntryField
      autoCapitalize="none"
      spellCheck={false}
      {...props}
      type={show ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="inv-eye"
          aria-label={show ? (hideLabel ?? t('Hide the password')) : (showLabel ?? t('Show the password'))}
          aria-pressed={show}
          disabled={props.disabled}
          onClick={() => setShow((s) => !s)}
        >
          <I name={show ? 'eyeOff' : 'eye'} size={16} />
        </button>
      }
    />
  );
}

/** The way in: the form's submit, orange; a spinner beside its words while it is on its way. */
export function GoButton({ busy, children, className = '', type = 'submit', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...rest} type={type} className={`gate-go ${className}`} aria-busy={busy || undefined}>
      {/* the spinner beside the words, not before them in the row: the words stay where they are */}
      <span>
        {busy && <Spinner />}
        {children}
      </span>
    </button>
  );
}

/** The way on as a link (a link that ended: "Sign in"; confirmed: "Open Lampo"): the same orange. */
export function GoLink({ children, className = '', ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} className={`gate-go ${className}`}>
      <span>{children}</span>
    </a>
  );
}

/** The other way on, quieter (Send it again, Deny, Open the library): the same size, the plain material. */
export function AltButton({ children, className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} type={type} className={`gate-alt ${className}`}>
      {children}
    </button>
  );
}

/** The line kept for what went wrong: always one line tall, so a message never moves the button. */
export function ErrorLine({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <p id={id} className="gate-error" role="alert" aria-live="polite">
      {children || ' '}
    </p>
  );
}

/**
 * What went wrong last: `miss(text, field)` says it on the ErrorLine, shakes `field` (by its input's name) and moves
 * the cursor there; `clear()` once the person types again.
 */
export function useMisses() {
  const [error, setError] = useState<string | null>(null);
  const [misses, setMisses] = useState(0);
  const [field, setField] = useState<string | null>(null);
  const shake: Shake | undefined = misses ? (misses % 2 ? 'a' : 'b') : undefined;
  return {
    error,
    /** The shake for one field: only the one the last miss was about, and only while it is said. */
    shakeOf: (name: string) => (error && field === name ? shake : undefined),
    miss(text: string, name: string | null = null) {
      setError(text);
      setMisses((n) => n + 1);
      setField(name);
      if (name) document.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.focus();
    },
    /** A message that isn't a miss (too many tries, the server's answer): said, nothing shakes. */
    say(text: string | null) {
      setError(text);
      setField(null);
    },
    clear: () => setError(null),
  };
}
