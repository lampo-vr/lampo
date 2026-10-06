// Voice notes: whether they are written down, the languages you speak (yours, on your account), and — folded away —
// which engine and model do it and why. The engine itself is the server's configuration (config.json "stt" or
// VR_STT_* variables, a restart), so only whoever runs the app sees it and where to change it; the languages are a
// person’s choice.
import { can } from '../../../lib/permissions.ts';
import { useAuthStatus, useUpdateMe } from '../api/auth.ts';
import { useInfo, useSttStatus } from '../api/queries.ts';
import type { Info } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { toastError } from '../lib/toast.ts';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { Progress } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { Segmented } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { Card, Code, Details, Facts } from './parts.tsx';

type Stt = NonNullable<Info['stt']>;

// What the engines understand well (Parakeet v3's 25 European languages, plus Whisper's most asked-for).
const LANGUAGES = 'bg,cs,da,de,el,en,es,et,fi,fr,hr,hu,it,lt,lv,mt,nl,no,pl,pt,ro,ru,sk,sl,sv,uk,tr,ar,hi,ja,ko,zh'.split(',');

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([locale()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** On, and if it isn't simply ready, what it is doing. */
function state(s: Stt): { label: string; tone: Tone; detail?: string } {
  if (s.backend === 'off') return { label: t('Off'), tone: 'neutral', detail: t('Voice notes keep their audio; nothing writes them down.') };
  if (s.error) return { label: t('Not working'), tone: 'must', detail: s.error };
  switch (s.state) {
    case 'ready':
      return { label: t('On'), tone: 'ok' };
    case 'downloading':
      return {
        label: t('On'),
        tone: 'ok',
        detail: s.progress != null ? t('Getting the speech model ready… {pct} %', { pct: Math.round(s.progress * 100) }) : t('Getting the speech model ready…'),
      };
    case 'loading':
    case 'starting':
      return { label: t('On'), tone: 'ok', detail: t('Loading the speech model…') };
    default:
      return { label: t('On'), tone: 'ok', detail: t('The speech model loads with the first voice note.') };
  }
}

/**
 * Where it is written down, said to whoever reads it: on a person's own computer, that computer; on a hosted server,
 * the server their workspace is on, and whether the recording goes anywhere else. A Mac's graphics chip is in Details.
 */
const where = (s: Stt, machine: boolean) => {
  if (s.backend === 'local')
    return machine
      ? t('Written down on the computer Lampo runs on, by its own speech model. The recording never leaves it.')
      : t('Written down on the server your workspace is on, by Lampo’s own speech model. The recording isn’t sent to any other service.');
  if (s.backend === 'http') return t('Written down by the speech service Lampo is set up with: the recording is sent there to be written down.');
  return machine ? t('Switched off on the computer Lampo runs on.') : t('Switched off on this server.');
};

/** The model's name and, in one line, why it is the one. */
function model(s: Stt): { name: string; why?: string } | null {
  if (s.backend === 'off') return null;
  if (s.backend === 'http') return s.model ? { name: s.model } : null;
  const id = s.model || 'auto';
  if (id === 'whisper-turbo')
    return {
      name: 'Whisper large-v3 turbo',
      why: t(
        'The most accurate of the engines here in our tests, also in noise and with German and English mixed; under half a second per note on a graphics chip.',
      ),
    };
  if (id === 'parakeet-v3')
    return { name: 'Parakeet v3', why: t('For servers without a graphics chip: a third of a second per note, where Whisper takes seconds.') };
  if (id === 'qwen3-asr-1.7b') return { name: 'Qwen3-ASR 1.7B' };
  if (id === 'auto') return { name: t('Picked at the first voice note'), why: t('Whisper large-v3 turbo on a graphics chip, Parakeet v3 without one.') };
  // A model file of its own: its name, never the server's path to it.
  return { name: id.split(/[\\/]/).pop() || id };
}

const device = (d: string) => (/^(cpu)/i.test(d) ? t('Processor ({id})', { id: d }) : t('Graphics chip ({id})', { id: d }));

/** The browser's languages we can hear, for a first list when someone leaves Automatic and the server has none. */
function browserLanguages(): string[] {
  const codes = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => l.slice(0, 2).toLowerCase());
  const known = [...new Set(codes)].filter((c) => LANGUAGES.includes(c)).slice(0, 8);
  return known.length ? known : ['en'];
}

/**
 * The languages you speak: Automatic (any language, as detected) or your own list as removable chips with a picker for
 * one more; saved on your account at once. Taking the last language off is Automatic too.
 */
function Languages({ server }: { server: string[] }) {
  const user = useAuthStatus().data?.user;
  const update = useUpdateMe();
  const mine = user?.prefs?.voice_languages;
  const list = mine ?? server;
  const auto = list.length === 0;
  const save = (voice_languages: string[] | null) => update.mutateAsync({ prefs: { voice_languages } }).catch(toastError);
  const rest = LANGUAGES.filter((l) => !list.includes(l)).sort((a, b) => languageName(a).localeCompare(languageName(b), locale()));
  // Automatic where the server already is: its choice again. Leaving Automatic: the server's list where it has one,
  // else the browser's languages.
  const choose = (v: string) => {
    if (v === 'auto' && !auto) save(server.length ? [] : null);
    if (v === 'list' && auto) save(server.length ? null : browserLanguages());
  };
  return (
    <Card
      title={t('Languages you speak')}
      lede={
        auto
          ? t('Every note is heard in the language it is spoken in, whichever that is.')
          : t('A note in any language is understood. One that sounds like a language you don’t speak is heard again as your first.')
      }
    >
      <Segmented
        label={t('Languages you speak')}
        className="set-lang-mode"
        value={auto ? 'auto' : 'list'}
        onChange={(v) => v && !update.isPending && choose(v)}
        options={[
          { value: 'auto', label: t('Automatic') },
          { value: 'list', label: t('My languages') },
        ]}
      />
      {!auto && (
        <div className="set-langs" data-testid="voice-languages">
          {list.map((l, i) => (
            <span key={l} className="set-lang-chip">
              {languageName(l)}
              {i === 0 && list.length > 1 && <span className="set-sub">{t('first')}</span>}
              <button
                type="button"
                className="set-lang-x"
                aria-label={t('Remove {name}', { name: languageName(l) })}
                disabled={update.isPending}
                onClick={() => save(list.filter((x) => x !== l))}
              >
                <I name="x" size={12} />
              </button>
            </span>
          ))}
          {list.length < 8 && (
            <Select
              label={t('Add a language')}
              value=""
              onChange={(v) => v && save([...list, v])}
              options={[{ value: '', label: t('Add a language…') }, ...rest.map((l) => ({ value: l, label: languageName(l) }))]}
            />
          )}
        </div>
      )}
      {mine !== undefined && (server.length > 0 || mine.length > 0) ? (
        <div className="set-inline">
          <span className="set-sub">{t('Yours only.')}</span>
          <button type="button" className="btn sm ghost" onClick={() => save(null)} disabled={update.isPending}>
            {server.length ? t('Use the server’s ({list}) instead', { list: server.map(languageName).join(', ') }) : t('Use the server’s choice instead')}
          </button>
        </div>
      ) : (
        <p className="set-hint set-sub">{t('The server’s choice until you change it.')}</p>
      )}
    </Card>
  );
}

export function Speech() {
  const s = useSttStatus(true);
  const status = useAuthStatus().data;
  const role = status?.user?.role;
  // the engine, the model and how to change them are for whoever runs the app: the person at their own computer, a
  // hosted server's operator; a workspace on a hosted server can't change them
  const machine = useInfo()?.mode === 'local';
  const runs = machine || !!status?.operator;
  const st = s && state(s);
  const m = s && model(s);
  return (
    <>
      <header className="set-head">
        <h1>{t('Voice notes')}</h1>
        <p>{t('Hold the mic and talk: what you say is written down and pinned to the frame, like a typed note.')}</p>
      </header>
      <Card title={t('Speech to text')} lede={s ? where(s, machine) : undefined}>
        {!s || !st ? (
          <SkeletonRegion label={t('Loading the speech engine’s state')}>
            <RowsSkeleton n={1} thumb={false} />
          </SkeletonRegion>
        ) : (
          <div className="set-voice" data-testid="speech-facts">
            <Badge tone={st.tone}>{st.label}</Badge>
            {st.detail && <span className="set-sub">{st.detail}</span>}
            {s.state === 'downloading' && s.progress != null && <Progress value={s.progress * 100} label={t('Model download')} />}
          </div>
        )}
      </Card>
      {s && s.backend !== 'off' && <Languages server={s.languages ?? []} />}
      {s && runs && (
        <Details title={t('Details')} hint={t('Engine and model, and how to change them')} testid="speech-details">
          <Facts
            rows={[
              { label: t('Engine'), value: s.backend === 'local' ? 'transcribe.cpp' : s.backend === 'http' ? t('An OpenAI-compatible endpoint') : t('None') },
              !!m && { label: t('Model'), value: m.why ? `${m.name} — ${m.why}` : m.name },
              !!s.device && { label: t('Runs on'), value: device(s.device) },
              s.backend === 'local' && {
                label: t('Also possible'),
                value: t('Any OpenAI-compatible speech endpoint (/v1/audio/transcriptions): a GPU box of your own or a hosted API.'),
              },
            ]}
          />
          {can(role, 'admin') && (
            <>
              <p className="set-sub">
                {t(
                  'The engine is the server’s configuration: config.json under “stt”, or VR_STT_* variables, then a restart. docs/speech.md lists every option.',
                )}
              </p>
              <Code label="config.json">{'{\n  "stt": {\n    "backend": "local",\n    "model": "auto",\n    "languages": ["de", "en"]\n  }\n}'}</Code>
              <Code label={t('or in the environment')}>{'VR_STT=local\nVR_STT_MODEL=auto\nVR_STT_LANGUAGES=de,en'}</Code>
            </>
          )}
        </Details>
      )}
    </>
  );
}
