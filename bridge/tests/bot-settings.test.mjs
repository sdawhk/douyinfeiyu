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
    azureTts: { enabled: false, key: 'azure-private-key', region: 'eastus' },
    xfyunTts: { enabled: false, appId: '12345678', authMode: 'password', apiPassword: 'tts-private-password' },
    singing: { enabled: false, apiKey: 'music-private-key' },
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
    assert.equal(before.settings.pokeInteraction.pokeBack, true);
    assert.equal(before.settings.autoSticker, true);
    assert.equal(before.settings.qzoneSocial.enabled, false);
    assert.deepEqual(before.settings.replyControl, { privateEnabled: true, groupEnabled: true, disabledPrivate: [], disabledGroups: [] });
    assert.equal(before.settings.qzoneSocial.previewOnly, true);
    assert.deepEqual(before.settings.ownerCardLike, { enabled: true, time: '10:00' });
    assert.deepEqual(before.settings.messageBatch, { enabled: true, idleMs: 5000, maxMs: 15000 });
    assert.equal(JSON.stringify(before).includes('private-token'), false);
    assert.equal(JSON.stringify(before).includes('azure-private-key'), false);
    assert.equal(JSON.stringify(before).includes('tts-private-password'), false);
    assert.equal(JSON.stringify(before).includes('music-private-key'), false);
    assert.equal(before.settings.azureTts.hasKey, true);
    assert.equal(before.settings.xfyunTts.hasApiPassword, true);
    assert.equal(before.settings.singing.hasApiKey, true);
    const next = structuredClone(before.settings);
    next.groupReplyCooldownMs = 12_000;
    next.replyControl = { privateEnabled: false, groupEnabled: true, disabledPrivate: ['123456789'], disabledGroups: ['839367702'] };
    next.messageBatch = { enabled: true, idleMs: 4000, maxMs: 12000 };
    next.groupInterjectionDisabled = ['839367702'];
    next.dailyQzone.minIntervalMs = 7_200_000;
    next.ownerCardLike = { enabled: true, time: '21:30' };
    next.stickerCooldown.privateMs = 60_000;
    next.stickerCooldown.privateRequestMs = 0;
    next.pokeInteraction.pokeBack = true;
    next.autoSticker = false;
    next.pokeInteraction.replies = '戳到啦\n在呢';
    const after = saveSettingsDocument(before.version, next, file);
    assert.notEqual(after.version, before.version);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.snowluma.accessToken, 'private-token');
    assert.equal(saved.dailyQzone.ownerQQ, '1668389572');
    assert.equal(saved.dailyQzone.minIntervalMs, 7_200_000);
    assert.deepEqual(saved.ownerCardLike, { enabled: true, time: '21:30' });
    assert.equal(saved.stickerCooldown.privateMs, 60_000);
    assert.equal(saved.stickerCooldown.privateRequestMs, 0);
    assert.deepEqual(saved.groupInterjectionDisabled, ['839367702']);
    assert.deepEqual(saved.replyControl, next.replyControl);
    assert.deepEqual(saved.messageBatch, next.messageBatch);
    assert.equal(saved.pokeInteraction.pokeBack, true);
    assert.equal(saved.autoSticker, false);
    assert.equal(saved.pokeInteraction.replies, '戳到啦\n在呢');
    assert.equal(saved.azureTts.key, 'azure-private-key');
    assert.equal(saved.xfyunTts.apiPassword, 'tts-private-password');
    assert.equal(saved.singing.apiKey, 'music-private-key');
    assert.equal(saved.edgeTts.url, 'http://127.0.0.1:18902');
    assert.equal(saved.edgeTts.workerUrl, 'https://tts.wangwangit.com');
    assert.equal(after.settings.edgeTts.url, 'https://tts.wangwangit.com');
    next.xfyunTts = { ...next.xfyunTts, apiPassword: '', clearApiPassword: true };
    const clearedXfyun = saveSettingsDocument(after.version, next, file);
    assert.equal('apiPassword' in JSON.parse(readFileSync(file, 'utf8')).xfyunTts, false);
    assert.throws(() => saveSettingsDocument(clearedXfyun.version, { ...next, xfyunTts: { ...next.xfyunTts, enabled: true } }, file), { status: 400 });
    next.azureTts = { ...next.azureTts, key: '', clearKey: true };
    saveSettingsDocument(clearedXfyun.version, next, file);
    assert.equal('key' in JSON.parse(readFileSync(file, 'utf8')).azureTts, false);
    assert.throws(() => saveSettingsDocument(before.version, next, file), { status: 409 });
    assert.throws(() => validateSettings({ ...next, groupReplyCooldownMs: -1 }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, replyControl: { ...next.replyControl, disabledGroups: ['invalid'] } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, messageBatch: { enabled: true, idleMs: 5000, maxMs: 4000 } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, stickerCooldown: { ...next.stickerCooldown, privateMs: -1 } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, pokeInteraction: { ...next.pokeInteraction, replies: '' } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, qzoneSocial: { ...next.qzoneSocial, allowedFriends: ['not-a-qq'] } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, qzoneSocial: { ...next.qzoneSocial, commentThreshold: next.qzoneSocial.likeThreshold - 1 } }), { status: 400 });
    assert.throws(() => validateSettings({ ...next, ownerCardLike: { ...next.ownerCardLike, time: '25:00' } }), { status: 400 });
  } finally {
    unlinkSync(file);
    try { unlinkSync(`${file}.bak`); } catch { /* no backup was written before a failed save */ }
  }
});
