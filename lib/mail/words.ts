// What the emails say, in English and German (du, like the app). One entry per sentence; {name} placeholders are filled
// by lib/mail/templates.ts (escaped for HTML). test/unit/mail-templates.test.ts checks that both languages carry the
// same placeholders and snapshots every message.
export type MailLang = 'en' | 'de';

export const WORDS = {
  // the frame around every message
  'footer.brand': { en: '{brand} · {host}', de: '{brand} · {host}' },
  'footer.account': { en: 'You get this because you have an account on {host}.', de: 'Du bekommst diese E-Mail, weil du ein Konto auf {host} hast.' },
  'footer.signup': {
    en: 'You get this because this address was used to sign up on {host}.',
    de: 'Du bekommst diese E-Mail, weil mit dieser Adresse ein Konto auf {host} angelegt wurde.',
  },
  'footer.change': {
    en: 'You get this because this address was entered for an account on {host}.',
    de: 'Du bekommst diese E-Mail, weil diese Adresse für ein Konto auf {host} eingetragen wurde.',
  },
  'footer.invite': {
    en: 'You get this because this address was invited on {host}.',
    de: 'Du bekommst diese E-Mail, weil diese Adresse auf {host} eingeladen wurde.',
  },
  'footer.workspace': {
    en: 'You get this because you work in the workspace “{workspace}” on {host}.',
    de: 'Du bekommst diese E-Mail, weil du im Workspace „{workspace}“ auf {host} arbeitest.',
  },
  'footer.workspace.own': {
    en: 'You get this because you have a workspace on {host}.',
    de: 'Du bekommst diese E-Mail, weil du einen Workspace auf {host} hast.',
  },
  'footer.test': {
    en: 'You get this because someone sent a test from {host}.',
    de: 'Du bekommst diese E-Mail, weil jemand von {host} aus einen Test geschickt hat.',
  },
  'link.paste': { en: 'Or open this link:', de: 'Oder öffne diesen Link:' },
  hi: { en: 'Hi {name},', de: 'Hallo {name},' },

  // verify: a new account's address
  'verify.subject': { en: 'Confirm your email for {brand}', de: 'Bestätige deine E-Mail-Adresse für {brand}' },
  'verify.title': { en: 'Confirm your email address', de: 'Bestätige deine E-Mail-Adresse' },
  'verify.body': {
    en: 'One step left: confirm that {email} is yours, and your account on {host} is ready.',
    de: 'Nur noch ein Schritt: Bestätige, dass {email} dir gehört, dann ist dein Konto auf {host} bereit.',
  },
  'verify.button': { en: 'Confirm my address', de: 'Adresse bestätigen' },
  'verify.note': {
    en: 'The link works once, for 24 hours. If you didn’t sign up, ignore this email: without the link, nothing happens.',
    de: 'Der Link funktioniert einmal, 24 Stunden lang. Wenn du kein Konto angelegt hast, ignoriere diese E-Mail: Ohne den Link passiert nichts.',
  },
  'verify.note.invited': { en: 'The link works once, for 24 hours.', de: 'Der Link funktioniert einmal, 24 Stunden lang.' },
  'verify.invited': {
    en: 'You joined {host}. Confirm that {email} is yours, so password resets and notices reach you.',
    de: 'Du bist jetzt auf {host}. Bestätige, dass {email} dir gehört, damit dich Passwort-Links und Hinweise erreichen.',
  },

  // verify-change: the new address of an email change
  'change.subject': { en: 'Confirm your new email for {brand}', de: 'Bestätige deine neue E-Mail-Adresse für {brand}' },
  'change.title': { en: 'Confirm your new address', de: 'Bestätige deine neue Adresse' },
  'change.body': {
    en: 'You asked to sign in to {host} with {email} from now on. Confirm that it’s yours and the change is made.',
    de: 'Du möchtest dich auf {host} ab jetzt mit {email} anmelden. Bestätige, dass die Adresse dir gehört, dann wird sie übernommen.',
  },
  'change.button': { en: 'Confirm the new address', de: 'Neue Adresse bestätigen' },
  'change.note': {
    en: 'Until then you keep signing in with your current address. The link works once, for 24 hours. Didn’t ask for this? Ignore this email.',
    de: 'Bis dahin meldest du dich weiter mit deiner bisherigen Adresse an. Der Link funktioniert einmal, 24 Stunden lang. Nicht von dir? Dann ignoriere diese E-Mail.',
  },

  // email-changed: a notice to the old address
  'changed.subject': { en: 'Your {brand} email address was changed', de: 'Deine E-Mail-Adresse bei {brand} wurde geändert' },
  'changed.title': { en: 'Your email address was changed', de: 'Deine E-Mail-Adresse wurde geändert' },
  'changed.body': {
    en: 'Your account on {host} now signs in with {email} instead of this address. Notices like this one go there from now on.',
    de: 'Dein Konto auf {host} meldet sich jetzt mit {email} statt mit dieser Adresse an. Hinweise wie dieser gehen ab jetzt dorthin.',
  },
  'changed.note': {
    en: 'If you didn’t make this change, tell whoever runs {host} right away.',
    de: 'Wenn du das nicht warst, wende dich sofort an die Person, die {host} betreibt.',
  },

  // reset: forgot password
  'reset.subject': { en: 'Reset your {brand} password', de: 'Setze dein Passwort für {brand} zurück' },
  'reset.title': { en: 'Reset your password', de: 'Passwort zurücksetzen' },
  'reset.body': {
    en: 'Someone, hopefully you, asked to reset the password of your account on {host}.',
    de: 'Jemand, hoffentlich du, möchte das Passwort deines Kontos auf {host} zurücksetzen.',
  },
  'reset.button': { en: 'Choose a new password', de: 'Neues Passwort wählen' },
  'reset.note': {
    en: 'The link works once, for 60 minutes. A new password signs you out on every other device. If you didn’t ask for this, ignore this email: your password stays as it is.',
    de: 'Der Link funktioniert einmal, 60 Minuten lang. Ein neues Passwort meldet dich auf allen anderen Geräten ab. Wenn du das nicht warst, ignoriere diese E-Mail: Dein Passwort bleibt, wie es ist.',
  },

  // password-changed: a notice
  'pwchanged.subject': { en: 'Your {brand} password was changed', de: 'Dein Passwort für {brand} wurde geändert' },
  'pwchanged.title': { en: 'Your password was changed', de: 'Dein Passwort wurde geändert' },
  'pwchanged.body': {
    en: 'The password of your account on {host} was changed on {when}. Every other device was signed out.',
    de: 'Das Passwort deines Kontos auf {host} wurde am {when} geändert. Alle anderen Geräte wurden abgemeldet.',
  },
  'pwchanged.note': {
    en: 'If this wasn’t you, choose a new password now and tell whoever runs {host}:',
    de: 'Wenn du das nicht warst, wähle jetzt ein neues Passwort und wende dich an die Person, die {host} betreibt:',
  },

  // invite
  // The words are the server's own: what people typed (their name, a workspace's name) is only ever quoted, in a line of
  // its own (invite.from), never the subject or a sentence that reads as the server speaking.
  'invite.subject': { en: 'An invite to {brand} on {host}', de: 'Eine Einladung zu {brand} auf {host}' },
  'invite.subject.org': { en: 'An invite to {org} on {brand}', de: 'Eine Einladung zu {org} auf {brand}' },
  'invite.title': { en: 'You’re invited', de: 'Du bist eingeladen' },
  'invite.body.reviewer': {
    en: 'You’re invited to review videos on {host}: watch, pin notes to exact frames, check fixes and approve.',
    de: 'Du bist eingeladen, auf {host} Videos zu prüfen: ansehen, Notizen auf exakte Frames setzen, Korrekturen prüfen und freigeben.',
  },
  'invite.body.member': {
    en: 'You’re invited to {host} as a member: review, upload, organise, share and hand work to agents.',
    de: 'Du bist als Mitglied zu {host} eingeladen: prüfen, hochladen, ordnen, teilen und Arbeit an Agenten geben.',
  },
  'invite.body.admin': {
    en: 'You’re invited to {host} as an admin: everything members do, and managing the people on it.',
    de: 'Du bist als Admin zu {host} eingeladen: alles, was Mitglieder tun, und dazu die Leute dort verwalten.',
  },
  'invite.body.owner': {
    en: 'You’re invited to {host} as an owner: everything, the server’s settings and its people included.',
    de: 'Du bist als Inhaber zu {host} eingeladen: alles, auch die Einstellungen des Servers und seine Leute.',
  },
  'invite.from': { en: 'From an account named “{by}”.', de: 'Von einem Konto namens „{by}“.' },
  'invite.from.workspace': {
    en: 'From an account named “{by}”, for a workspace named “{workspace}”.',
    de: 'Von einem Konto namens „{by}“, für einen Workspace namens „{workspace}“.',
  },
  'invite.button': { en: 'Accept the invite', de: 'Einladung annehmen' },
  'invite.note': {
    en: 'You choose your name and password. The link works once, until {until}.',
    de: 'Name und Passwort wählst du selbst. Der Link funktioniert einmal, bis {until}.',
  },

  // welcome, after a sign-up is confirmed
  'welcome.subject': { en: 'Welcome to {brand}', de: 'Willkommen bei {brand}' },
  'welcome.title': { en: 'Welcome, {name}', de: 'Willkommen, {name}' },
  'welcome.body': {
    en: 'Your address is confirmed and your account on {host} is ready. Upload a video, pin notes to exact frames, and your agents pick them up.',
    de: 'Deine Adresse ist bestätigt, dein Konto auf {host} ist bereit. Lade ein Video hoch, setze Notizen auf exakte Frames, und deine Agenten greifen sie auf.',
  },
  'welcome.button': { en: 'Open {brand}', de: '{brand} öffnen' },
  'welcome.note': {
    en: 'Agents connect with vr login {url} or as an MCP server: Settings → Connect an agent shows how.',
    de: 'Agenten verbinden sich mit vr login {url} oder als MCP-Server: Einstellungen → Agent verbinden zeigt, wie.',
  },

  // new-sign-in (opt-in)
  'signin.subject': { en: 'New sign-in to {brand}', de: 'Neue Anmeldung bei {brand}' },
  'signin.title': { en: 'A new sign-in to your account', de: 'Eine neue Anmeldung bei deinem Konto' },
  'signin.body': {
    en: 'Your account on {host} was signed in to from {device} on {when}.',
    de: 'Bei deinem Konto auf {host} hat sich {device} am {when} angemeldet.',
  },
  'signin.note': {
    en: 'If this was you, there’s nothing to do. If not, choose a new password now:',
    de: 'Wenn du das warst, musst du nichts tun. Wenn nicht, wähle jetzt ein neues Passwort:',
  },
  'signin.why': {
    en: 'You get these because sign-in alerts are on. Turn them off under Settings → Notifications.',
    de: 'Du bekommst diese E-Mails, weil Anmelde-Hinweise an sind. Ausschalten kannst du sie unter Einstellungen → Benachrichtigungen.',
  },

  // account removed / disabled by an admin
  'removed.subject': { en: 'Your {brand} account was removed', de: 'Dein Konto bei {brand} wurde gelöscht' },
  'removed.title': { en: 'Your account was removed', de: 'Dein Konto wurde gelöscht' },
  'removed.body': {
    en: 'An admin of {host} removed your account. You can’t sign in there any more; the notes you wrote stay with the team, signed with your name.',
    de: 'Ein Admin von {host} hat dein Konto gelöscht. Du kannst dich dort nicht mehr anmelden; deine Notizen bleiben beim Team, mit deinem Namen.',
  },
  'disabled.subject': { en: 'Your {brand} account was disabled', de: 'Dein Konto bei {brand} wurde deaktiviert' },
  'disabled.title': { en: 'Your account was disabled', de: 'Dein Konto wurde deaktiviert' },
  'disabled.body': {
    en: 'An admin of {host} disabled your account: you’re signed out everywhere and can’t sign in until it is enabled again.',
    de: 'Ein Admin von {host} hat dein Konto deaktiviert: Du bist überall abgemeldet und kannst dich erst wieder anmelden, wenn es wieder aktiviert ist.',
  },
  'admin.note': { en: 'Questions? Ask whoever runs {host}.', de: 'Fragen? Wende dich an die Person, die {host} betreibt.' },

  // account deleted by its own person (Settings → Profile, A13 PEOPLE-1)
  'deleted.subject': { en: 'Your {brand} account is deleted', de: 'Dein Konto bei {brand} ist gelöscht' },
  'deleted.title': { en: 'Your account is deleted', de: 'Dein Konto ist gelöscht' },
  'deleted.body': {
    en: 'You deleted your account on {host}: your profile, picture, drafts, unsent recordings and devices are gone, and you can’t sign in there any more. Notes you wrote stay in their workspaces, signed with your name.',
    de: 'Du hast dein Konto auf {host} gelöscht: Profil, Bild, Entwürfe, nicht gesendete Aufnahmen und Geräte sind weg, und du kannst dich dort nicht mehr anmelden. Notizen, die du geschrieben hast, bleiben in ihren Workspaces, mit deinem Namen.',
  },
  'deleted.note': {
    en: 'This is the last email you get from {host}. Didn’t do this? Ask whoever runs {host}.',
    de: 'Das ist die letzte E-Mail, die du von {host} bekommst. Das warst nicht du? Wende dich an die Person, die {host} betreibt.',
  },

  // a workspace suspended, lifted, deleted (the server's operator, or its owner: A13 CLOUD-5, PEOPLE-1)
  'suspended.subject': { en: '“{workspace}” is read-only for now', de: '„{workspace}“ ist vorerst nur lesbar' },
  'suspended.title': { en: 'Your workspace is suspended', de: 'Dein Workspace ist gesperrt' },
  'suspended.body': {
    en: 'Whoever runs {host} suspended the workspace “{workspace}”. You can still sign in, read and download what is in it, but nothing can be added or changed, and its review links don’t open any more.',
    de: 'Die Person, die {host} betreibt, hat den Workspace „{workspace}“ gesperrt. Du kannst dich weiter anmelden, alles darin lesen und herunterladen, aber nichts hinzufügen oder ändern, und seine Review-Links öffnen sich nicht mehr.',
  },
  'restored.subject': { en: '“{workspace}” works again', de: '„{workspace}“ funktioniert wieder' },
  'restored.title': { en: 'Your workspace works again', de: 'Dein Workspace funktioniert wieder' },
  'restored.body': {
    en: 'Whoever runs {host} lifted the suspension of “{workspace}”: everything works as before, its review links too.',
    de: 'Die Person, die {host} betreibt, hat die Sperre von „{workspace}“ aufgehoben: Alles funktioniert wie vorher, auch seine Review-Links.',
  },
  'restored.button': { en: 'Open {brand}', de: '{brand} öffnen' },
  'wsdeleted.subject': { en: '“{workspace}” was deleted', de: '„{workspace}“ wurde gelöscht' },
  'wsdeleted.title': { en: 'A workspace of yours was deleted', de: 'Ein Workspace von dir wurde gelöscht' },
  'wsdeleted.body.operator': {
    en: 'Whoever runs {host} deleted the workspace “{workspace}”, with its videos, notes, review links and files.',
    de: 'Die Person, die {host} betreibt, hat den Workspace „{workspace}“ gelöscht, mit seinen Videos, Notizen, Review-Links und Dateien.',
  },
  'wsdeleted.body.owner': {
    en: 'Its owner deleted the workspace “{workspace}” on {host}, with its videos, notes, review links and files.',
    de: 'Der Inhaber hat den Workspace „{workspace}“ auf {host} gelöscht, mit seinen Videos, Notizen, Review-Links und Dateien.',
  },
  'wsdeleted.body.you': {
    en: 'You deleted the workspace “{workspace}” on {host}, with its videos, notes, review links and files.',
    de: 'Du hast den Workspace „{workspace}“ auf {host} gelöscht, mit seinen Videos, Notizen, Review-Links und Dateien.',
  },
  'footer.workspace.was': {
    en: 'You get this because you worked in the workspace “{workspace}” on {host}.',
    de: 'Du bekommst diese E-Mail, weil du im Workspace „{workspace}“ auf {host} gearbeitet hast.',
  },
  'wsdeleted.account': {
    en: 'You worked in no other workspace there, so your account went with it: you can’t sign in to {host} any more.',
    de: 'Du hast dort in keinem anderen Workspace gearbeitet, deshalb wurde dein Konto mit gelöscht: Du kannst dich auf {host} nicht mehr anmelden.',
  },
  'wsdeleted.stays': {
    en: 'Your account and your other workspaces stay as they are.',
    de: 'Dein Konto und deine anderen Workspaces bleiben, wie sie sind.',
  },

  // signup-exists: the enumeration-safe answer's email
  'exists.subject': { en: 'You already have a {brand} account', de: 'Du hast schon ein Konto bei {brand}' },
  'exists.title': { en: 'You already have an account', de: 'Du hast schon ein Konto' },
  'exists.body': {
    en: 'Someone, hopefully you, tried to sign up on {host} with this address. It already has an account, so nothing new was made.',
    de: 'Jemand, hoffentlich du, wollte auf {host} mit dieser Adresse ein Konto anlegen. Es gibt schon eines dafür, also wurde nichts Neues angelegt.',
  },
  'exists.button': { en: 'Sign in', de: 'Anmelden' },
  'exists.note': { en: 'Forgot your password? Choose a new one:', de: 'Passwort vergessen? Wähle ein neues:' },

  // test
  'test.subject': { en: '{brand} test email', de: 'Test-E-Mail von {brand}' },
  'test.title': { en: 'Email works', de: 'E-Mail funktioniert' },
  'test.body': {
    en: 'This test from {host} arrived, so invites, sign-up confirmations and password resets will reach people.',
    de: 'Dieser Test von {host} ist angekommen: Einladungen, Bestätigungen und Passwort-Links erreichen also ihre Empfänger.',
  },
  'test.note': { en: 'Sent with vr admin mail-test on {when}.', de: 'Gesendet mit vr admin mail-test am {when}.' },
} as const satisfies Record<string, Record<MailLang, string>>;

export type WordKey = keyof typeof WORDS;

/** One sentence in a language, its placeholders filled (as given: the layout escapes for HTML). */
export function word(key: WordKey, lang: MailLang, vars: Record<string, string | number> = {}): string {
  return WORDS[key][lang].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The language a message goes out in: German only when it was chosen (the app is English unless German is picked). */
export const mailLang = (pref: string | null | undefined): MailLang => (pref === 'de' ? 'de' : 'en');
