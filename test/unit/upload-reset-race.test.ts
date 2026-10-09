// covers: web/src/uploads/uploads.ts web/src/files/uploadStore.ts web/src/lib/signedOut.ts
// An upload stopped while it looks for an earlier, interrupted try of itself (tus's resume lookup) stays stopped: signing
// out (or cancelling) lands while the lookup is out, the lookup answers afterwards, and nothing starts — tus's start()
// would bring an aborted upload back to life. Both stores, without a browser: the videos' with tus's own Upload class
// (its lookup held, its start recorded), the Files tab's through its Upload seam.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Upload } from 'tus-js-client';
import { until } from '../lib/helpers.ts';

// browser code: imported by URL, so the backend typecheck doesn't take it in
const video = (await import(new URL('../../web/src/uploads/uploads.ts', import.meta.url).href)) as {
  startUpload: (file: File, target: { folder?: string | null; slug?: string | null }) => Promise<void>;
};
const files = (await import(new URL('../../web/src/files/uploadStore.ts', import.meta.url).href)) as {
  fileIo: { api: unknown; Upload: unknown };
  sendFiles: (area: string, dir: string, items: { file: File; path: string; base: number | null; rel: string }[]) => string;
};
const { forgetInMemory } = (await import(new URL('../../web/src/lib/signedOut.ts', import.meta.url).href)) as { forgetInMemory: () => void };

/** An earlier try the lookup finds (what makes a resume): passed to resumeFromPreviousUpload. */
const previous = [
  { uploadUrl: 'http://media.test/api/uploads/u1', size: 16, metadata: { filename: 'cut.mp4', folder: 'Acme' }, creationTime: '', urlStorageKey: 'k' },
];
/** One turn of the event loop: every promise continuation queued before it has run. */
const turn = () => new Promise((r) => setImmediate(r));

test('a video upload signed out of while its resume lookup is out never starts, nor resumes', async () => {
  const proto = Upload.prototype as unknown as Record<string, unknown>;
  const real = { find: proto.findPreviousUploads, resume: proto.resumeFromPreviousUpload, start: proto.start };
  const did: string[] = [];
  let release: (() => void) | null = null;
  proto.findPreviousUploads = () =>
    new Promise((r) => {
      release = () => r(previous);
    });
  proto.resumeFromPreviousUpload = () => did.push('resume');
  proto.start = () => did.push('start');
  try {
    const going = video.startUpload(new File([new Uint8Array(16)], 'cut.mp4', { type: 'video/mp4' }), { folder: 'Acme' });
    await until(() => release, 'the lookup to be out');
    forgetInMemory();
    (release as unknown as () => void)();
    await going;
    assert.deepEqual(did, [], 'stopped stays stopped');
  } finally {
    Object.assign(proto, { findPreviousUploads: real.find, resumeFromPreviousUpload: real.resume, start: real.start });
  }
});

test('a project file signed out of while its resume lookup is out never starts, nor resumes', async () => {
  const did: string[] = [];
  let release: (() => void) | null = null;
  files.fileIo.api = async (url: string, init: { body: { files: { path: string }[] } }) => {
    if (url !== '/api/files/uploads') throw new Error(`not expected: ${url}`);
    return {
      folder: 'Acme',
      tus: 'http://media.test/api/uploads',
      uploads: init.body.files.map((f) => ({ path: f.path, ticket: `t-${f.path}`, expires: '' })),
    };
  };
  files.fileIo.Upload = class {
    findPreviousUploads() {
      return new Promise((r) => {
        release = () => r(previous);
      });
    }
    resumeFromPreviousUpload() {
      did.push('resume');
    }
    async abort() {}
    start() {
      did.push('start');
    }
  };
  files.sendFiles('Acme', '', [{ file: new File([new Uint8Array(16)], 'font.otf'), path: 'font.otf', base: null, rel: 'font.otf' }]);
  await until(() => release, 'the lookup to be out');
  forgetInMemory();
  (release as unknown as () => void)();
  await turn();
  await turn();
  assert.deepEqual(did, [], 'stopped stays stopped');
});
