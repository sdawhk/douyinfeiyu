import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readSettingsDocument, saveSettingsDocument, validateSettings } from '../src/bot-settings.mjs';

test('admin settings preserve unrelated secrets and reject stale saves', () => {
  const file = path.join(tmpdir(), `bot-settings-${randomBytes(8).toString('hex')}.json`);
  const original = {
    snowluma: { accessToken: 'private-token' },
    allow: { groups: [839367702] },
    dailyQzone: { ownerQQ: '1668389572', enabled: true, minute: 0 },
    ownerProactive: { enabled: true, idleMs: 7_200_000, checkIntervalMs: 900_000,
      cooldownMs: 14_400_000, maxPerDay: 3, startHour: 9, endHour: 22 },
    groupReplyCooldownMs: 20_000
  };
  writeFileSync(file, JSON.stringify(original));
  try {
    const before = readSettingsDocument(file);
    assert.deepEqual(before.groups, ['839367702']);
    assert.equal(JSON.stringify(before).includes('private-token'), false);
    const next = structuredClone(before.settings);
    next.groupReplyCooldownMs = 12_000;
    next.groupInterjectionDisabled = ['839367702'];
    next.dailyQzone.minIntervalMs = 7_200_000;
    next.pokeInteraction.pokeBack = true;
    next.pokeInteraction.replies = '戳到啦\n在呢';
    const after = saveSettingsDocument(before.version, next, file);
    assert.notEqual(after.version, before.version);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.snowluma.accessToken, 'private-token');
    assert.equal(saved.dailyQzone.ownerQQ, '1668389572');
    assert.equal(saved.dailyQzone.minIntervalMs, 7_200_000);
    assert.deepEqual(saved.groupInterjectionDisabled, ['839367702']);
    assert.equal(saved.pokeInteraction.pokeBack, true);
    assert.equal(saved.pokeInteraction.replies, '戳到啦\n在呢');
    assert.throws(() => saveSettingsDocument(before.version, next, file), { status: 409 });
    assert.throws(() => validateSettings({ ...next, groupReplyCooldownMs: -1 }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, pokeInteraction: { ...next.pokeInteraction, replies: '' } }), { status: 400 });
  } finally {
    unlinkSync(file);
    unlinkSync(`${file}.bak`);
  }
});
