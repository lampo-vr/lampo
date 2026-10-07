// The footage indexer works through the one job queue. A render it found the queue full for is not dropped (the status
// would say "waiting" for it for good): its turn comes again later, and it is indexed once there is room.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { age, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake', VR_OCR: 'off' } });
const store = await import('../../lib/store.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const jobs = await import('../../lib/jobs.ts');
const { createEmbedder, resetEmbedder } = await import('../../lib/footage/embedder.ts');
const { createIndexer, QUEUE_RETRY } = await import('../../lib/footage/indexer.ts');
const service = await import('../../lib/footage/service.ts');
const { closeIndexes } = await import('../../lib/footage/db.ts');

resetEmbedder(createEmbedder({ kind: 'fake' }));
after(() => {
  resetEmbedder();
  closeIndexes();
});

test('a render the queue had no room for is indexed once there is room', async () => {
  const file = makeVideo(path.join(dir, 'in', 'full.mp4'), { w: 160, h: 90, dur: 1 });
  age(file);
  const { review } = store.createOrGetReview(file, { by: 'tester' });
  QUEUE_RETRY.ms = 200;
  const kept = { ...jobs.QUEUE_LIMITS };
  Object.assign(jobs.QUEUE_LIMITS, { perWorkspace: 0, reserved: 0 });
  const indexer = createIndexer({ log: () => {} });
  try {
    indexer.queue(review);
    const key = renderKey(review.versions[0] as Parameters<typeof renderKey>[0]);
    await until(() => !indexer.busy(key), 'the queue refused it');
  } finally {
    Object.assign(jobs.QUEUE_LIMITS, kept);
  }
  assert.equal(service.status().indexed, 0, 'nothing yet');
  await until(
    () => service.status().indexed === 1,
    () => JSON.stringify(service.status()),
    30_000,
  );
});
