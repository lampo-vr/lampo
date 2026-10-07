// The check before any byte moves (design §6.2): what was dropped, counted — its top folders and its size, what the
// workspace holds already (named by its bytes, hashed in a worker while this is open), what becomes a new version of a
// file there, what is left out and why — and whether it fits the plan, with the way out when it doesn't. A folder this
// size goes faster from a terminal: the command, ready to copy. Then the files go to the tray.
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { BillingInfo, FilesMissing } from '../../../lib/types.ts';
import { api } from '../api/client.ts';
import { locale, t } from '../i18n/index.ts';
import { openLimit, toastError } from '../lib/toast.ts';
import { Code } from '../settings/parts.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Modal } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { filesUnder } from './api.ts';
import type { Gathered } from './drop.ts';
import { type HashProgress, hashFiles } from './hash.ts';
import { type Existing, nameOf, planDrop, pushCommand, roomAfter, settlePlan, size, spaced } from './model.ts';
import { sendFiles } from './uploadStore.ts';

/** From here a terminal is the better way: the sheet says so with the command. */
const BIG_BYTES = 20e9;
const BIG_COUNT = 1000;

/** A few names, then how many more: ".DS_Store, ._A001C003.mov, Thumbs.db +2" (junk in one order: the disk's differs). */
const some = (names: string[], n = 3) => `${names.slice(0, n).join(', ')}${names.length > n ? ` +${names.length - n}` : ''}`;

function Line({ glyph, children, value, testid }: { glyph: ReactNode; children: ReactNode; value?: ReactNode; testid?: string }) {
  return (
    <li className="pf-ck-line" data-testid={testid}>
      <span className="pf-ck-glyph">{glyph}</span>
      <span className="pf-ck-text">{children}</span>
      {value !== undefined && <span className="pf-ck-value">{value}</span>}
    </li>
  );
}

export function CheckSheet({
  area,
  dir,
  gathered,
  billing,
  onClose,
}: {
  area: string;
  /** The folder of the area it goes into ('' = the top). */
  dir: string;
  gathered: Gathered;
  billing: BillingInfo | null | undefined;
  onClose: () => void;
}) {
  const [existing, setExisting] = useState<Existing | null>(null);
  useEffect(() => {
    let live = true;
    filesUnder(area, dir)
      .then((rows) => live && setExisting(new Map(rows.map((r) => [r.path, { id: r.id, v: r.v, sha256: r.sha256, size: r.size, path: r.path }]))))
      .catch((e) => {
        toastError(e);
        if (live) setExisting(new Map());
      });
    return () => {
      live = false;
    };
  }, [area, dir]);
  const plan = useMemo(() => (existing ? planDrop(gathered.picked, dir, existing, gathered.junk) : null), [existing, gathered, dir]);
  const [hashing, setHashing] = useState<HashProgress | null>(null);
  useEffect(
    () =>
      hashFiles(
        gathered.picked.map((p) => p.file),
        (p) => setHashing({ ...p }),
      ),
    [gathered],
  );
  // once the hashes are in: which of them the workspace holds already (anywhere: their bytes aren't sent again)
  const [stored, setStored] = useState<ReadonlySet<string>>(new Set());
  const hashed = !!hashing?.done;
  useEffect(() => {
    if (!hashed || !plan || !hashing) return;
    const asked = [...new Set(plan.add.map((x) => hashing.hashes.get(x.file)).filter((h): h is string => !!h))];
    if (!asked.length) return;
    let live = true;
    (async () => {
      const missing = new Set<string>();
      for (let i = 0; i < asked.length; i += 5000)
        for (const h of (await api<FilesMissing>('/api/files/missing', { method: 'POST', body: { hashes: asked.slice(i, i + 5000) } })).missing) missing.add(h);
      if (live) setStored(new Set(asked.filter((h) => !missing.has(h))));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [hashed, plan, hashing]);

  const settled = plan ? settlePlan(plan, (f) => hashing?.hashes.get(f), stored) : null;
  const replacing = plan ? plan.add.filter((x) => x.replaces && !settled?.isSame(x)) : [];
  const going = plan && settled ? plan.add.length - settled.same : 0;
  const limit = billing?.limits.bytes ?? null;
  const room = settled ? roomAfter(limit, billing?.usage.bytes ?? 0, settled.send, settled.freed) : null;
  const short = room !== null && room < 0;
  const where = area ? (area.split('/').at(-1) as string) : t('House');
  const into = dir ? `${where} · ${spaced(dir)}` : where;
  const n = gathered.picked.length;
  const big = !!plan && (plan.bytes >= BIG_BYTES || n >= BIG_COUNT);
  // the terminal's source: the one folder dropped, by its name
  const tops = new Set(gathered.picked.map((p) => p.rel.split('/')[0]));
  const source = tops.size === 1 && gathered.picked[0]?.rel.includes('/') ? `./${[...tops][0]}` : './<folder>';
  const add = () => {
    if (!plan || !settled) return;
    const items = plan.add
      .filter((x) => !settled.isSame(x))
      .map((x) => ({
        file: x.file,
        path: x.path,
        base: x.base,
        sha256: hashing?.hashes.get(x.file) ?? null,
        rel: dir ? x.path.slice(dir.length + 1) : x.path,
      }));
    if (items.length) sendFiles(area, dir, items);
    onClose();
  };
  const plans = () =>
    openLimit({
      reason: 'storage',
      needed: settled?.send ?? 0,
      name: t('{n} file|{n} files', { n: going }),
      message: t('This is {size}; the workspace has {left} left.', {
        size: size(settled?.send ?? 0),
        left: size(Math.max(0, (limit ?? 0) - (billing?.usage.bytes ?? 0))),
      }),
    });
  return (
    <Modal
      title={t('Add {n} file to {where}|Add {n} files to {where}', { n, where: into })}
      onClose={onClose}
      width={560}
      foot={
        <>
          <span className="grow pf-ck-foot" data-testid="files-check-send">
            {settled && hashed
              ? settled.send
                ? t('{size} to upload', { size: size(settled.send) })
                : t('Nothing to upload')
              : t('Uploads resume if the connection drops.')}
          </span>
          <button type="button" className="btn" data-keys="Esc" onClick={onClose}>
            {t('Cancel')}
          </button>
          {short ? (
            <button type="button" className="btn primary" onClick={plans} data-testid="files-check-plans">
              {t('See what fits')}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!plan} onClick={add} data-testid="files-check-add" data-keys="⌘↵">
              {plan && going === 0 ? t('Done') : t('Add {n} file|Add {n} files', { n: plan ? going : n })}
            </button>
          )}
        </>
      }
    >
      <ul className="pf-ck" data-testid="files-check">
        <Line glyph={<I name="folder" size={15} />} value={plan ? size(plan.bytes) : <SkLine w="4em" />} testid="files-check-what">
          {plan ? some(plan.tops.map(spaced), 4) || t('Nothing to add') : <SkLine w="12em" />}
        </Line>
        <Line glyph={<KeyGlyph shape={hashed ? 'diamond' : 'outline'} size={10} />} testid="files-check-known">
          {!hashing || !plan ? (
            <SkLine w="16em" />
          ) : !hashed ? (
            t('Checking what’s already in Lampo · {pct}%', { pct: hashing.total ? Math.floor((hashing.read / hashing.total) * 100) : 100 })
          ) : settled && settled.same + settled.known > 0 ? (
            t('{n} is already in Lampo: nothing to upload for it|{n} are already in Lampo: nothing to upload for them', { n: settled.same + settled.known })
          ) : (
            // (its bytes, not its files: some of them may still become new versions, the line below)
            t('Nothing to skip: all of it needs uploading')
          )}
        </Line>
        {replacing.length > 0 && (
          <Line glyph={<KeyGlyph shape="half" size={10} />} testid="files-check-versions">
            {t('{n} becomes a new version: {names}|{n} become new versions: {names}', {
              n: replacing.length,
              names: some(replacing.map((x) => `${nameOf(x.path)} (V${(x.base ?? 0) + 1})`)),
            })}
          </Line>
        )}
        {gathered.junk.length > 0 && (
          <Line glyph={<KeyGlyph shape="outline" size={10} />} testid="files-check-junk">
            {t('{n} left out: {names}', { n: gathered.junk.length, names: some([...gathered.junk].sort(new Intl.Collator(locale()).compare)) })}
          </Line>
        )}
        {plan && plan.bad.length + plan.clash.length > 0 && (
          <Line glyph={<I name="x" size={14} />} testid="files-check-bad">
            {plan.clash.length > 0 &&
              t('{n} can’t go beside a file whose name differs only in case: {names}', {
                n: plan.clash.length,
                names: some(plan.clash.map((c) => `${nameOf(c.path)} (${nameOf(c.with)})`)),
              })}
            {plan.clash.length > 0 && plan.bad.length > 0 && ' · '}
            {plan.bad.length > 0 &&
              t('{n} can’t be added: {names}', {
                n: plan.bad.length,
                names: some(
                  plan.bad.map((b) => `${nameOf(b.path)}: ${b.why}`),
                  2,
                ),
              })}
          </Line>
        )}
        {limit !== null && (
          <Line glyph={<I name="archive" size={14} />} testid="files-check-room">
            {room === null ? (
              <SkLine w="14em" />
            ) : short ? (
              <b className="pf-ck-short">
                {t('This is {size}; the workspace has {left} left. Remove files you no longer need, add fewer, or add storage.', {
                  size: size(settled?.send ?? 0),
                  left: size(Math.max(0, limit - (billing?.usage.bytes ?? 0))),
                })}
              </b>
            ) : (
              t('Room: {left} of {limit} left after this', { left: size(room), limit: size(limit) })
            )}
          </Line>
        )}
      </ul>
      {big && plan && (
        <div className="pf-ck-cli">
          <p>{t('A folder this size goes faster from a terminal:')}</p>
          <Code>{pushCommand(area, dir, source)}</Code>
        </div>
      )}
    </Modal>
  );
}
