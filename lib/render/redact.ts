// What of a failed render's output may leave the machine: its last meaningful lines, with anything that looks like a
// token, a key or a password taken out, at most 300 characters. The error reaches the person's Lampo (a hosted
// server too) and the agent's next line; a tool's output can hold a URL with credentials, a header, an environment
// dump. Pure and browser-safe.
import { plain } from './tools.ts';

/** The most of a tool's words a failure carries. */
export const ERROR_MAX = 300;
const CUT = '[redacted]';

// Names whose value is a secret, as a whole word or a part between separators: `token`, `access_token`, `DB_PASSWORD`,
// `X-Amz-Signature`, `client-secret`, `Authorization` (never `design` or `signal`).
const SECRET_NAME =
  '(?:[A-Za-z0-9]+[_.-])*(?:token|secret|password|passwd|passphrase|pwd|apikey|api[_-]key|access[_-]?key|private[_-]?key|credentials?|auth|authorization|cookie|signature|sig|session[_-]?id|sessionid)(?:[_.-][A-Za-z0-9]+)*';
// A MySQL or MariaDB client and the words it was given, as a shell runs them (or as a list: Python's
// "Command '['mysql', '-u', …]'"). The client is a word of its own (after a space, a quote, "(" or a shell separator),
// or run from a bin folder (/usr/bin/mysql; never another path that ends in its name, /tmp/mysql). Its words, quoted
// ones too, reach up to a shell separator (; & | a backquote, and " · " between lines) or the next client, and its
// password is the word glued to a lower-case -p (-P is the port), so a later -p… of another command (ffmpeg -pix_fmt)
// is never one. Linear in the line: no word holds a place where a client could begin (each such place inside one is
// checked), so no word is read for two clients, and each place reads one way only.
const SQL_CLIENT = String.raw`(?:(?:[^\s;&|\x60()"']*[/\\])?s?bin[/\\])?(?:[Mm][Yy][Ss][Qq][Ll](?:dump|admin|import|sh|check|pump|slap)?|[Mm][Aa][Rr][Ii][Aa][Dd][Bb](?:-[a-z]+)?)(?:\.[Ee][Xx][Ee])?["']?,?(?=[ \t])`;
/** The rest of a quoted word after its opening `q`, up to its closing one on the line, with no client begun inside. */
const quotedRest = (q: string, other: string) => String.raw`(?:[^${q}\s;&|\x60${other}(]|(?!\n)[\s;&|\x60${other}(](?!${SQL_CLIENT}))*${q}(?!${SQL_CLIENT})`;
const SHELL_WORD = String.raw`(?:"(?!${SQL_CLIENT})(?:${quotedRest('"', "'")}|(?!${quotedRest('"', "'")}))|'(?!${SQL_CLIENT})(?:${quotedRest("'", '"')}|(?!${quotedRest("'", '"')}))|\((?!${SQL_CLIENT})|[^\s;&|\x60·"'(])+`;
const MYSQL_PASSWORD = new RegExp(
  String.raw`((?<![^\s;&|\x60("'])${SQL_CLIENT}(?:[ \t]+(?!${SQL_CLIENT})${SHELL_WORD})*?[ \t]+["']?-p)(?!\[redacted\])(?:"[^"\n]*"\S*|'[^'\n]*'\S*|\S+)`,
  'g',
);
const RULES: [RegExp, (...m: string[]) => string][] = [
  // a private key block, whole (the patterns here are written so that no line of this file looks like a key itself)
  [/-{5}BEGIN [A-Z ]*PRIVATE[ ]KEY-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE[ ]KEY-{5}|$)/g, () => CUT],
  // Authorization headers' schemes
  [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, (_m, scheme) => `${scheme} ${CUT}`],
  // credentials in a URL: scheme://user:password@host, and a password with no user (redis://:password@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, (_m, scheme) => `${scheme}${CUT}@`],
  // name=value, name: value, "name": "value", ?name=value&
  [new RegExp(String.raw`(["']?\b${SECRET_NAME}\b["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;&"'})\]]+)`, 'gi'), (_m, head) => `${head}${CUT}`],
  // --name value
  [new RegExp(String.raw`(--?${SECRET_NAME}\s+)(?!-)\S+`, 'gi'), (_m, head) => `${head}${CUT}`],
  // a name ending in "key" after a separator — OPENAI_KEY=…, stripe.key: …, x-signing-key=… (never keyint= or colorkey=)
  [/(["']?\b(?:[A-Za-z0-9]+[_.-])+key\b["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;&"'})\]]+)/gi, (_m, head) => `${head}${CUT}`],
  // a name with a secret's word glued on (PGPASSWORD=, DBSECRET=) or ending in "pass" after a separator (SMTP_PASS=)
  [
    /(["']?\b[A-Za-z0-9]+(?:password|passwd|passphrase|secret|token)\b["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;&"'})\]]+)/gi,
    (_m, head) => `${head}${CUT}`,
  ],
  [/(["']?\b(?:[A-Za-z0-9]+[_.-])+pass\b["']?\s*[:=]\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;&"'})\]]+)/gi, (_m, head) => `${head}${CUT}`],
  // a MySQL or MariaDB client's password glued to -p (mysql -u root -psecret)
  [MYSQL_PASSWORD, (_m, head) => `${head}${CUT}`],
  // a user and password given to a command: curl -u user:password, --user user:password, --proxy-user …
  [/((?:^|\s)(?:-u|--user|--proxy-user|-U)(?:\s+|=))([^\s:@]+):(?!\/\/)\S+/g, (_m, head, user) => `${head}${user}:${CUT}`],
  // webhook addresses are their own credential (Slack, Discord)
  [/\b(https?:\/\/hooks\.slack\.com\/)(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/gi, (_m, host) => `${host}${CUT}`],
  [/\b(https?:\/\/(?:www\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]+/gi, (_m, host) => `${host}${CUT}`],
  // well-known token shapes
  [/\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{16,}/g, () => CUT],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github[_]pat[_][A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, () => CUT],
  [/\b(?:AK|AS)IA[0-9A-Z]{16}\b/g, () => CUT],
  // SendGrid, Hugging Face and npm tokens
  [/\bS[G]\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, () => CUT],
  [/\bh[f]_[A-Za-z0-9]{20,}/g, () => CUT],
  [/\bnp[m]_[A-Za-z0-9]{30,}/g, () => CUT],
  // an AWS secret access key: 40 letters, digits, "+" and "/" on its own (a path has dots, dashes or underscores, or
  // starts with "/"), with digits and both cases
  [
    /(?<![A-Za-z0-9/+=._-])[A-Za-z0-9+][A-Za-z0-9/+]{39}(?![A-Za-z0-9/+=._-])/g,
    (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) && m.includes('/') ? CUT : m),
  ],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => CUT],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => CUT],
  // Lampo's own tokens
  [/\bvr[a-z]?_[A-Za-z0-9_-]{16,}/g, () => CUT],
  // anything else long and random: 32+ hex digits, or 32+ base64 letters with digits and both cases (a file's name
  // with separators or a path never is one)
  [/\b[0-9a-f]{32,}\b/gi, () => CUT],
  [/[A-Za-z0-9+]{32,}={0,2}/g, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? CUT : m)],
];

/** Text with anything that looks like a secret replaced by "[redacted]" (again on text redacted before: the same). */
export function redact(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by);
  return out;
}

// Lines that say nothing about what went wrong: progress, a stack's frames, bars, blank ones.
const NOISE = [
  /^\s*$/,
  /^\s*at\s+\S/, // a stack frame
  /^\s*[-=━─_.·•*>]{3,}\s*$/,
  /^\s*(?:frame|size|time|bitrate|speed)=/i, // ffmpeg's stats line
  /^\s*(?:frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time(?:_us|_ms)?|dup_frames|drop_frames|speed|progress)=/, // -progress
  /^\s*(?:Bundl(?:ing|ed)|Render(?:ing|ed)|Encod(?:ing|ed)|Mux(?:ing|ed))\b.*(?:\d+\s*\/\s*\d+|%)/, // Remotion's progress
  /\bFra:\s*\d+/, // Blender's
  /^\s*PROGRESS:\s+\d/, // aerender's
];
const SAYS_WRONG =
  /error|fail|fatal|cannot|can['’]t|could ?n['’]?o?t|unable|not found|no such|missing|invalid|denied|refused|exception|abort|killed|out of memory|timed? ?out|stopped/i;
/** How far back from the end a line saying what went wrong is looked for. */
const LOOK_BACK = 12;

/**
 * What went wrong, from a failed tool's last lines: `quote` holds the lines from the first in the last few that says
 * something went wrong (or the last three) as one redacted line ≤ ERROR_MAX characters, `line` the single line an agent
 * reads (≤ 200). `home` (the person's home folder) is said as `~`.
 */
export function failureWords(lines: readonly string[], { home }: { home?: string } = {}): { quote: string; line: string } {
  const clean = lines
    .flatMap((l) => plain(l).split('\n'))
    .filter((l) => !NOISE.some((re) => re.test(l)))
    .slice(-40)
    .map((l) => {
      const t = l.trim().replace(/\s+/g, ' ');
      return home && home.length > 1 ? t.split(home).join('~') : t;
    });
  if (!clean.length) return { quote: '', line: '' };
  const tail = Math.max(0, clean.length - LOOK_BACK);
  const firstWrong = clean.findIndex((l, i) => i >= tail && SAYS_WRONG.test(l));
  const lastWrong = clean.findLastIndex((l, i) => i >= tail && SAYS_WRONG.test(l));
  const parts = (firstWrong >= 0 ? clean.slice(Math.max(firstWrong, clean.length - 8)) : clean.slice(-3)).map(redact);
  // when it is long, the end of what it said matters most: drop lines from the front, then cut the one left
  let quote = parts.join(' · ');
  while (quote.length > ERROR_MAX && parts.length > 1) {
    parts.shift();
    quote = parts.join(' · ');
  }
  if (quote.length > ERROR_MAX) quote = `${quote.slice(0, ERROR_MAX - 1).trimEnd()}…`;
  let line = redact(clean[lastWrong >= 0 ? lastWrong : clean.length - 1]);
  if (line.length > 200) line = `${line.slice(0, 199).trimEnd()}…`;
  return { quote, line };
}
