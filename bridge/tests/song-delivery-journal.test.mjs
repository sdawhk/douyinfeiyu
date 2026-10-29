import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSongDeliveryJournal } from '../src/song-delivery-journal.mjs';

test('song delivery facts are scoped to a chat and survive bridge restart', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'song-delivery-journal-'));
  const filePath = path.join(temp, 'journal.json');
  let now = 10_000;
  try {
    const firstRun = createSongDeliveryJournal({ filePath, now: () => now });
    assert.equal(firstRun.record({ chatKey: 'g12345', title: '雨爱司凤版', mode: 'cover', status: 'sent', seconds: 30 }), true);
    assert.equal(firstRun.record({ chatKey: 'g12345', title: '另一首歌', mode: 'cover', status: 'failed' }), true);
    assert.equal(firstRun.record({ chatKey: 'p67890', title: '私聊歌曲', status: 'sent' }), true);

    const afterRestart = createSongDeliveryJournal({ filePath, now: () => now });
    assert.deepEqual(afterRestart.recent('g12345').map(({ title, status }) => ({ title, status })), [
      { title: '雨爱司凤版', status: 'sent' }, { title: '另一首歌', status: 'failed' }
    ]);
    assert.equal(afterRestart.recent('p67890')[0].title, '私聊歌曲');
    assert.deepEqual(afterRestart.recent('g99999'), []);
    now += 25 * 60 * 60_000;
    assert.deepEqual(afterRestart.recent('g12345'), [], 'stale delivery facts expire from model context');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
