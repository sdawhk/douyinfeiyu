import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callOnebotApi } from '../src/onebot-api.mjs';

const FRAME_SIZE = Math.floor(144 * 128_000 / 44_100);
const FRAMES = 1150;

test('active bridge song commands are deterministic and settle quota only on OneBot success', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'song-command-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import('../src/song-library.mjs');
  const commands = await import(`../src/song-library-commands.mjs?test=${Date.now()}`);
  t.after(() => {
    library.closeSongLibraryForTests();
    delete process.env.DSH_SONG_LIBRARY_DB;
    rmSync(temp, { recursive: true, force: true });
  });
  commands.resetSongLibraryCommandStateForTests();
  assert.equal(commands.shouldRouteSongLibraryCommand('歌单', { replyEnabled: true, muted: false }), true);
  assert.equal(commands.shouldRouteSongLibraryCommand('歌单', { replyEnabled: false, muted: false }), false);
  assert.equal(commands.shouldRouteSongLibraryCommand('试听 0123456789ab', { replyEnabled: true, muted: true }), false);
  assert.equal(commands.shouldRouteSongLibraryCommand('闭嘴', { replyEnabled: false, muted: true }), false);
  assert.equal(commands.isSongLibraryCommand('闭嘴'), false, 'mute controls remain on their existing downstream route');
  assert.equal(commands.normalizeSongCommandText('@小鲸鱼 歌单', { selfNickname: '小鲸鱼' }), '歌单');
  assert.equal(commands.normalizeSongCommandText('@群友 歌单', { selfNickname: '小鲸鱼' }), '@群友 歌单');

  const audio = Buffer.alloc(FRAME_SIZE * FRAMES);
  for (let index = 0; index < FRAMES; index++) audio.writeUInt32BE(0xfffb9000, index * FRAME_SIZE);
  const file = path.join(temp, 'preview.mp3');
  writeFileSync(file, audio);
  assert.equal(library.registerSongOutput({ file, title: '歌单测试', query: '歌单测试', mode: 'ai', seconds: 30 }, { decodeImpl: () => true }), true);
  const songId = library.listSongs().songs[0].song_id;
  const messages = [];
  let sentAudio = null;
  const base = { key: 'group:12345', senderId: '67890', isGroup: true,
    sendText: async (message) => messages.push(message), sendRecord: async (data) => { sentAudio = data; },
    refreshLibrary: () => ({ indexed: 0, rejected: 0 }) };

  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '歌单' }), true);
  assert.match(messages.at(-1), new RegExp(songId));
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: `试听 ${songId}` }), true);
  assert.ok(Buffer.isBuffer(sentAudio));
  assert.equal(library.getFreeQuota().dailyUsed, 1);

  const failing = { ...base, key: 'private:12345', sendRecord: async () => { throw new Error('OneBot send_group_msg failed: rejected'); } };
  assert.equal(await commands.handleSongLibraryCommand({ ...failing, text: `试听 ${songId}` }), true);
  assert.equal(library.getFreeQuota().dailyUsed, 1, 'definite OneBot failure releases the reservation');
  assert.match(messages.at(-1), /没有发送成功/);

  const packet = library.recordRedPacketCandidate({ botId: '90000', messageId: 'paid-command-credit', senderId: '67890', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: packet.candidate_id, amountCents: 100, receiptRef: 'paid-command-receipt' });
  let paidSends = 0;
  const paid = await commands.handleSongLibraryCommand({ ...base, text: '新歌试听 精确歌名', coverEnabled: true,
    makePaidPreview: async (query) => ({ audio: Buffer.alloc(1024), title: query, sourceIdentity: 'https://example.test/exact-song' }),
    sendRecord: async () => { paidSends++; } });
  assert.equal(paid, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(paidSends, 1);
  assert.equal(library.getVerifiedCreditBalance('67890'), 0, 'paid preview settles once after confirmed send');
  assert.match(messages.at(-1), /已扣 1.00 元/);
  const retryPacket = library.recordRedPacketCandidate({ botId: '90000', messageId: 'paid-command-credit-2', senderId: '67890', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: retryPacket.candidate_id, amountCents: 100, receiptRef: 'paid-command-receipt-2' });
  const uncertain = await commands.handleSongLibraryCommand({ ...base, text: '新歌试听 另一首精确歌名', coverEnabled: true,
    makePaidPreview: async () => ({ audio: Buffer.alloc(1024), title: '另一首精确歌名', sourceIdentity: 'https://example.test/another' }),
    sendRecord: async () => { const error = new Error('send timeout'); error.uncertain = true; throw error; } });
  assert.equal(uncertain, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(library.getVerifiedCreditBalance('67890'), 0, 'uncertain send keeps its credit reserved');
  let duplicateSend = false;
  await commands.handleSongLibraryCommand({ ...base, text: '新歌试听 另一首精确歌名', coverEnabled: true,
    makePaidPreview: async () => assert.fail('uncertain order must not be automatically retried'),
    sendRecord: async () => { duplicateSend = true; } });
  assert.equal(duplicateSend, false);
  assert.match(messages.at(-1), /正在处理或待核对/);
  assert.equal(library.getFreeQuota().dailyUsed, 1, 'blocked paid commands do not consume free quota');

  let friendCalls = 0;
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '好友列表', getFriendList: async () => { friendCalls++; return []; } }), true);
  assert.equal(friendCalls, 0, 'friend list command is intercepted but owner-only');
  assert.match(messages.at(-1), /只允许主人私聊/);
});

test('candidate notification is private, owner-only, and excludes the bot account', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'red-packet-notice-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import('../src/song-library.mjs');
  const commands = await import(`../src/song-library-commands.mjs?red-packet-notice=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });

  const sends = [];
  const event = { self_id: 90000, user_id: 80000, message_id: 'm-1', message: [{ type: 'text', data: { text: '[QQ红包]请使用新版手机QQ查收红包。' } }] };
  assert.equal(await commands.handleRedPacketCandidateNotice({ event, botId: '90000', chatKey: 'group:70000', ownerIds: ['90000'], sendPrivate: async (...args) => sends.push(args) }), true);
  assert.equal(sends.length, 0, 'the bot account is never notified as the owner');
  assert.equal(library.listPendingRedPacketCandidates().length, 1);
  assert.equal(await commands.handleRedPacketCandidateNotice({ event, botId: '90000', chatKey: 'group:70000', ownerIds: ['90000', '60000'], sendPrivate: async (...args) => sends.push(args) }), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], '60000');
  assert.match(sends[0][1], /疑似/);
  assert.match(sends[0][1], /不是到账证明/);
  await commands.handleRedPacketCandidateNotice({ event, botId: '90000', chatKey: 'group:70000', ownerIds: ['60000'], sendPrivate: async (...args) => sends.push(args) });
  assert.equal(sends.length, 1, 'a confirmed owner notification is not repeated');
  const failedEvent = { ...event, message_id: 'm-2', user_id: 80001 };
  await commands.handleRedPacketCandidateNotice({ event: failedEvent, botId: '90000', chatKey: 'group:70000', ownerIds: ['60000'], sendPrivate: async () => { throw new Error('send failed'); } });
  await commands.handleRedPacketCandidateNotice({ event: failedEvent, botId: '90000', chatKey: 'group:70000', ownerIds: ['60000'], sendPrivate: async (...args) => sends.push(args) });
  assert.equal(sends.length, 1, 'a failed send leaves the candidate queryable without retrying a possibly delivered notice');
  assert.equal(await commands.handleRedPacketCandidateNotice({ event: { ...event, message: [{ type: 'text', data: { text: '[QQ红包] fake' } }] }, botId: '90000', chatKey: 'group:70000', ownerIds: ['60000'], sendPrivate: async () => assert.fail('text marker must not notify') }), false);
  const candidateId = library.listPendingRedPacketCandidates()[0].candidate_id;
  const replies = [];
  assert.equal(await commands.handleSongLibraryCommand({ text: `红包通过 ${candidateId} 100 owner-receipt-1`, key: 'private:80000', senderId: '80000', isGroup: false, isOwner: false, botId: '90000', sendText: async (message) => replies.push(message) }), true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 0, 'non-owner approval is rejected');
  assert.equal(await commands.handleSongLibraryCommand({ text: `红包通过 ${candidateId} 100 owner-receipt-1`, key: 'private:90000', senderId: '90000', isGroup: false, isOwner: true, botId: '90000', sendText: async (message) => replies.push(message) }), true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 0, 'bot account cannot approve its own candidate');
  assert.equal(await commands.handleSongLibraryCommand({ text: `红包通过 ${candidateId} 100 owner-receipt-1`, key: 'private:60000', senderId: '60000', isGroup: false, isOwner: true, botId: '90000', sendText: async (message) => replies.push(message) }), true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 100);
});

test('full-song paid order preserves confirmed segments and resumes without duplicate sends', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-full-command-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-full=${Date.now()}`);
  const sharedLibrary = await import('../src/song-library.mjs');
  const commands = await import(`../src/song-library-commands.mjs?paid-full=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); sharedLibrary.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const packet = library.recordRedPacketCandidate({ botId: '90000', messageId: 'full-credit', senderId: '67890', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: packet.candidate_id, amountCents: 300, receiptRef: 'full-credit-ref' });
  const audio = [1, 2, 3].map((value) => Buffer.alloc(1024, value));
  const full = { title: '整首测试歌', sourceIdentity: 'https://example.test/full#sha256=stable', voiceVariant: 'rvc:0',
    segments: audio.map((data, segmentIndex) => ({ segmentIndex, startSeconds: segmentIndex * 30, seconds: 30,
      audio: data, cachePath: path.join(temp, `segment-${segmentIndex}.mp3`) })) };
  let attempt = 1;
  const producerOptions = [];
  const sent = [];
  const base = { text: '唱完整首 整首测试歌', key: 'group:34567', senderId: '67890', isGroup: true, coverEnabled: true,
    sendText: async () => {}, makePaidFullSong: async (query, orderId, options) => { producerOptions.push(options); return full; },
    sendRecord: async (data) => { const value = data[0]; sent.push(value); if (attempt === 1 && value === 2) throw new Error('OneBot rejected segment'); } };
  assert.equal(await commands.handleSongLibraryCommand(base), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(library.getVerifiedCreditBalance('67890'), 0, 'partial delivery retains its reservation');
  const resumeOrder = library.reservePaidSongOrder({ senderId: '67890', chatKey: 'group:34567', query: '整首测试歌', kind: 'full' });
  assert.equal(resumeOrder.resume, true);
  assert.deepEqual(library.listPaidSongSegments(resumeOrder.orderId).map((item) => item.status), ['sent', 'ready', 'ready']);
  assert.equal(library.reservePaidSongOrder({ senderId: '67890', chatKey: 'group:34567', query: '整首测试歌', kind: 'full' }).reason,
    'conversation-busy', 'only one process may claim a partial order resume');
  library.updatePaidSongOrder(resumeOrder.orderId, { status: 'partial' });
  attempt = 2;
  assert.equal(await commands.handleSongLibraryCommand(base), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, [1, 2, 2, 3], 'resume skips the confirmed first segment');
  assert.equal(producerOptions[1].resume.title, '整首测试歌');
  assert.deepEqual(producerOptions[1].resume.segments.map((segment) => segment.status), ['sent', 'ready', 'ready']);
  assert.equal(library.getVerifiedCreditBalance('67890'), 0, 'full order charges exactly once after every segment is confirmed');
});

test('OneBot delivery confirmation requires a successful HTTP and OneBot response', async () => {
  const ok = await callOnebotApi({ httpUrl: 'http://onebot.test/', action: 'send_group_msg',
    params: { group_id: 12345, message: [{ type: 'record', data: { file: 'base64://AA==' } }] },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://onebot.test/send_group_msg');
      assert.equal(options.headers['content-type'], 'application/json');
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 7 } }) };
    } });
  assert.deepEqual(ok, { message_id: 7 });
  await assert.rejects(callOnebotApi({ httpUrl: 'http://onebot.test', action: 'send_group_msg',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, wording: 'rejected' }) }) }), /OneBot send_group_msg 失败/);
  await assert.rejects(callOnebotApi({ httpUrl: 'http://onebot.test', action: 'send_group_msg',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ status: 'ok', retcode: 0 }) }) }),
  (error) => /OneBot send_group_msg 失败/.test(error.message) && error.uncertain === true);
});
