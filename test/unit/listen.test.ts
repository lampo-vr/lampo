// A second server on a taken port must say so and stop, not print "video-review on …" and run without a listener.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { listen } from '../../server/listen.ts';

test('a taken port is an error that names the port and the fix; a free one serves', async () => {
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
  const port = (taken.address() as AddressInfo).port;
  try {
    await assert.rejects(listen(express(), port, '127.0.0.1'), (e: Error) => {
      assert.match(e.message, new RegExp(`127\\.0\\.0\\.1:${port} is already in use`));
      assert.match(e.message, /LAMPO_PORT/);
      return true;
    });
  } finally {
    await new Promise((r) => taken.close(r));
  }
  const app = express().get('/ping', (_req, res) => {
    res.send('pong');
  });
  const server = await listen(app, port, '127.0.0.1');
  try {
    assert.equal((server.address() as AddressInfo).port, port);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), 'pong');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
