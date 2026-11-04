import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callOnebotApi } from '../src/onebot-api.mjs';
import { findCachedSongInPlaylist, listCachedSongPlaylist, loadSongOutputById, saveSongOutput } from '../src/song-output-cache.mjs';

const FRAME_SIZE = Math.floor(144 * 128_000 / 44_100);
const FRAMES = 1150;

test('full-song aliases and natural phrasing normalize to the deterministic command', async () => {
  const commands = await import(`../src/song-library-commands.mjs?full-song-aliases=${Date.now()}`);
  for (const [input, expected] of [
    ['唱完整首雨爱司凤版', '唱完整首 雨爱司凤版'],
    ['唱完整版 嘲', '唱完整首 嘲'],
    ['唱整首嘲', '唱完整首 嘲'],
    ['唱整首 嘲', '唱完整首 嘲'],
    ['唱完整版嘲', '唱完整首 嘲'],
    ['唱《嘲》的完整版', '唱完整首 嘲'],
    ['给我唱一下《嘲》完整版', '唱完整首 嘲'],
    ['我想听你唱《嘲》的完整版', '唱完整首 嘲'],
    ['能不能唱一下嘲的完整版', '唱完整首 嘲'],
    ['把《嘲》唱完整', '唱完整首 嘲'],
    ['把嘲唱完', '唱完整首 嘲'],
    ['能不能把嘲唱完', '唱完整首 嘲'],
    ['《嘲》唱完整版', '唱完整首 嘲'],
  ]) {
    assert.equal(commands.normalizeSongCommandText(input), expected);
    assert.equal(commands.isSongLibraryCommand(input), true, `${input} stays on the deterministic full-song route`);
  }
});

test('current song policy lists and sends cached songs, while keeping previews and red packets off', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'song-current-policy-test-'));
  const cacheRoot = path.join(temp, 'song-cache');
  const cached = saveSongOutput({ query: '测试歌', title: '测试歌', mode: 'ai', candidate: 1,
    startSeconds: 30, seconds: 60, voiceVariant: 'rvc:0:clear-v4' }, Buffer.alloc(2048, 4), { root: cacheRoot });
  let testNow = Date.now();
  t.mock.method(Date, 'now', () => testNow);
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import('../src/song-library.mjs');
  const commands = await import(`../src/song-library-commands.mjs?current=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const messages = [];
  const deliveryFacts = [];
  const catalog = { getCachedPlaylist: () => listCachedSongPlaylist({ root: cacheRoot }),
    getCachedOutput: (id) => loadSongOutputById(id, { root: cacheRoot }),
    findCachedSong: (query) => findCachedSongInPlaylist(query, { root: cacheRoot }) };
  const base = { key: 'group:12345', senderId: '67890', isGroup: true,
    sendText: async (message) => messages.push(message), sendRecord: async () => assert.fail('disabled preview must not send audio'),
    onSongDelivery: (event) => deliveryFacts.push(event), ...catalog };
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'ai', '67890', []), true);
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'ai', '67890', ['67890']), false);
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'original', '67890', ['67890']), false);
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'search', '67890', []), false);
  assert.equal(commands.shouldBlockLegacySongRequest(true, 'ai', '67890', []), false);
  assert.equal(commands.isSongLibraryCommand('点歌1'), true);
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '歌单' }), true);
  assert.match(messages.at(-1), /测试歌/);
  assert.match(messages.at(-1), /点歌1/);
  assert.equal(commands.isSongLibraryCommand('1'), false, 'plain numbers are never global commands');
  assert.equal(commands.isPendingPlaylistNumber('1', base.key), true);
  assert.equal(commands.isPendingPlaylistNumber('2', base.key), false);
  assert.equal(commands.isPendingPlaylistNumber('1', 'group:other'), false);
  for (const text of ['试听1', '新歌试听 测试歌', '我的点歌额度']) {
    assert.equal(await commands.handleSongLibraryCommand({ ...base, text }), true);
    assert.match(messages.at(-1), /停用|关掉/);
  }
  let selected = null;
  let sends = 0;
  const pick = { ...base, text: '点歌1', sourceMessageId: 'qq-pick-1',
    coverEnabled: false, sendRecord: async (audio) => { sends++; assert.equal(audio[0], 4); },
    onPlaylistSelection: (song) => { selected = song; } };
  assert.equal(await commands.handleSongLibraryCommand({ ...pick, text: '1', sourceMessageId: 'qq-number-1' }), true);
  assert.equal(sends, 1);
  assert.equal(commands.isPendingPlaylistNumber('1', base.key), false, 'a numeric selection closes the five-minute window');
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '歌单' }), true);
  assert.match(messages.at(-1), /纯数字点歌已用过/);
  assert.equal(commands.isPendingPlaylistNumber('1', base.key), false, 'relisting cannot reset the window');
  assert.equal(await commands.handleSongLibraryCommand(pick), true);
  assert.equal(sends, 2, 'the explicit 点歌 command remains available');
  assert.equal(selected.id, cached.id);
  assert.equal(deliveryFacts.at(-1).status, 'sent');
  assert.equal(await commands.handleSongLibraryCommand({ ...pick, key: 'g12345' }), true);
  assert.equal(sends, 2, 'the same QQ event cannot send twice through both bridge listeners');
  testNow += 5 * 60_000 + 1;
  assert.equal(commands.isPendingPlaylistNumber('1', base.key), false);
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '歌单' }), true);
  assert.equal(commands.isPendingPlaylistNumber('1', base.key), true, 'a new list opens one numeric selection after five minutes');
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '红包账本' }), true);
  assert.match(messages.at(-1), /停用/);
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '唱完整首 歌单外', coverEnabled: true }), true);
  assert.match(messages.at(-1), /歌单里已有/);
  let sent = 0;
  assert.equal(await commands.handleSongLibraryCommand({ ...base, senderId: '60000',
    text: '唱完整版 测试歌', coverEnabled: true,
    makePaidFullSong: async () => ({ title: '测试歌', sourceIdentity: 'source:current-policy', voiceVariant: 'rvc:0',
      segments: [{ segmentIndex: 0, startSeconds: 0, seconds: 30, audio: Buffer.alloc(1024), cachePath: path.join(temp, 'song.mp3') }] }),
    sendRecord: async () => { sent++; } }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 1);
  assert.match(messages.join('\n'), /歌单整首免费/);
  assert.match(messages.join('\n'), /不扣点歌单位/);
});

// 历史付费/试听流程已通过总开关停用；保留用例供重新启用时复核。
test.skip('active bridge song commands are deterministic and settle quota only on OneBot success', async (t) => {
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
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'ai'), true, 'group members cannot bypass paid previews with legacy singing');
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'original'), true, 'group members cannot bypass paid previews with source audio');
  assert.equal(commands.shouldBlockLegacySongRequest(false, 'search'), false, 'search without audio remains available');
  assert.equal(commands.shouldBlockLegacySongRequest(true, 'ai'), false, 'the owner keeps the legacy singing command');
  assert.equal(commands.normalizeSongCommandText('@小鲸鱼 歌单', { selfNickname: '小鲸鱼' }), '歌单');
  assert.equal(commands.normalizeSongCommandText('@群友 歌单', { selfNickname: '小鲸鱼' }), '@群友 歌单');
  assert.equal(commands.isSongLibraryCommand('新歌试听雨爱司凤版'), true, 'compact preview command stays on the deterministic song route');

  const audio = Buffer.alloc(FRAME_SIZE * FRAMES);
  for (let index = 0; index < FRAMES; index++) audio.writeUInt32BE(0xfffb9000, index * FRAME_SIZE);
  const file = path.join(temp, 'preview.mp3');
  writeFileSync(file, audio);
  assert.equal(library.registerSongOutput({ file, title: '歌单测试', query: '歌单测试', mode: 'ai', seconds: 30 }, { decodeImpl: () => true }), true);
  const songId = library.listSongs().songs[0].song_id;
  const messages = [];
  const deliveryFacts = [];
  let sentAudio = null;
  let audioSends = 0;
  const base = { key: 'group:12345', senderId: '67890', isGroup: true,
    sendText: async (message) => messages.push(message), sendRecord: async (data) => { sentAudio = data; audioSends++; },
    onSongDelivery: (event) => deliveryFacts.push(event),
    refreshLibrary: () => ({ indexed: 0, rejected: 0 }) };

  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: '歌单' }), true);
  assert.match(messages.at(-1), /歌单测试/);
  assert.equal(await commands.handleSongLibraryCommand({ ...base, text: `试听 ${songId}`, sourceMessageId: 'qq-preview-1' }), true);
  assert.ok(Buffer.isBuffer(sentAudio));
  assert.deepEqual(deliveryFacts.at(-1), { title: '歌单测试', mode: 'playlist', status: 'sent', seconds: 30 });
  assert.equal(library.getFreeQuota().dailyUsed, 1);
  const messageCount = messages.length;
  assert.equal(await commands.handleSongLibraryCommand({ ...base, key: 'g12345', text: `试听 ${songId}`, sourceMessageId: 'qq-preview-1' }), true);
  assert.equal(audioSends, 1, 'two bridge entry points send the same QQ preview only once');
  assert.equal(messages.length, messageCount, 'duplicate event sends no second confirmation');
  assert.equal(library.getFreeQuota().dailyUsed, 1, 'duplicate event does not consume free quota twice');

  assert.equal(await commands.handleSongLibraryCommand({ ...base, senderId: 'owner-123', isOwner: true,
    text: `试听 ${songId}`, sourceMessageId: 'qq-owner-preview-1' }), true);
  assert.equal(audioSends, 2, 'the owner preview is delivered');
  assert.equal(library.getFreeQuota().dailyUsed, 1, 'the owner preview does not consume global free quota');
  assert.match(messages.at(-1), /主人试听不占用全局免费次数/);

  const failing = { ...base, key: 'private:12345', sendRecord: async () => { throw new Error('OneBot send_group_msg failed: rejected'); } };
  assert.equal(await commands.handleSongLibraryCommand({ ...failing, text: `试听 ${songId}` }), true);
  assert.equal(library.getFreeQuota().dailyUsed, 1, 'definite OneBot failure releases the reservation');
  assert.match(messages.at(-1), /没有发送成功/);

  const packet = library.recordRedPacketCandidate({ botId: '90000', messageId: 'paid-command-credit', senderId: '67890', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: packet.candidate_id, amountCents: 100, receiptRef: 'paid-command-receipt' });
  let paidSends = 0;
  const paid = await commands.handleSongLibraryCommand({ ...base, text: '新歌试听 精确歌名', sourceMessageId: 'qq-paid-1', coverEnabled: true,
    makePaidPreview: async (query) => ({ audio: Buffer.alloc(1024), title: query, sourceIdentity: 'https://example.test/exact-song' }),
    sendRecord: async () => { paidSends++; } });
  assert.equal(paid, true);
  assert.equal(await commands.handleSongLibraryCommand({ ...base, key: 'g12345', text: '新歌试听 精确歌名', sourceMessageId: 'qq-paid-1', coverEnabled: true,
    makePaidPreview: async () => assert.fail('duplicate event must not generate a second paid preview'),
    sendRecord: async () => assert.fail('duplicate event must not send a second paid preview') }), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(paidSends, 1);
  assert.equal(library.getVerifiedCreditBalance('67890'), 100, 'paid preview does not rewrite verified cash ledger');
  assert.equal(library.getPaidSongUnitSummary('67890').consumed, 1, 'paid preview settles one unit after confirmed send');
  assert.deepEqual(deliveryFacts.at(-1), { title: '精确歌名', mode: 'paid-preview', status: 'sent', seconds: 30 });
  assert.match(messages.at(-1), /已结算 1 个点歌单位/);
  await commands.handleSongLibraryCommand({ ...base, text: '我的点歌额度' });
  assert.match(messages.at(-1), /累计来源为核验金额折算 3、赠送发放 0/);
  assert.match(messages.at(-1), /已用 1、预留 0，可用 2/);
  const retryPacket = library.recordRedPacketCandidate({ botId: '90000', messageId: 'paid-command-credit-2', senderId: '67890', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: retryPacket.candidate_id, amountCents: 100, receiptRef: 'paid-command-receipt-2' });
  const uncertain = await commands.handleSongLibraryCommand({ ...base, text: '新歌试听 另一首精确歌名', coverEnabled: true,
    makePaidPreview: async () => ({ audio: Buffer.alloc(1024), title: '另一首精确歌名', sourceIdentity: 'https://example.test/another' }),
    sendRecord: async () => { const error = new Error('send timeout'); error.uncertain = true; throw error; } });
  assert.equal(uncertain, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(library.getVerifiedCreditBalance('67890'), 200, 'uncertain send does not rewrite verified cash ledger');
  assert.equal(library.getPaidSongUnitSummary('67890').reserved, 1, 'uncertain send keeps its unit reserved');
  assert.equal(deliveryFacts.at(-1).status, 'uncertain', 'uncertain QQ delivery is recorded as needing confirmation');
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

test.skip('candidate notification is private, owner-only, and excludes the bot account', async (t) => {
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

test.skip('full-song paid order preserves confirmed segments and resumes without duplicate sends', async (t) => {
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
  assert.equal(library.getPaidSongUnitSummary('67890').reserved, 3, 'partial delivery retains its unit reservation');
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
  assert.equal(library.getPaidSongUnitSummary('67890').consumed, 3, 'full order consumes three units after every segment is confirmed');
});

test.skip('gifted full-song command reserves, resumes, and consumes an entitlement without cash wording', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-gift-command-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import('../src/song-library.mjs');
  const commands = await import(`../src/song-library-commands.mjs?paid-gift-command=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  library.grantPaidFullSongEntitlement({ grantId: 'stable-gift-command-grant', senderId: '1060100883', count: 2,
    sourceNote: '主人陈述此前 5 元红包，金额未核实', reportedAmountCents: 500 });
  const lines = [];
  const audio = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)];
  const full = { title: '赠送歌曲', sourceIdentity: 'source-hash', voiceVariant: 'rvc:0', duration: 50,
    segments: audio.map((data, segmentIndex) => ({ segmentIndex, startSeconds: segmentIndex * 30,
      seconds: segmentIndex === 0 ? 30 : 20, audio: data, cachePath: `gift-${segmentIndex}.mp3` })) };
  let sends = 0;
  let attempt = 1;
  const base = { text: '唱完整首 赠送歌曲', key: 'group:gift', senderId: '1060100883', isGroup: true, coverEnabled: true,
    sendText: async (message) => lines.push(message), makePaidFullSong: async () => full,
    sendRecord: async (buffer) => { sends++; if (attempt === 1 && buffer === audio[1]) throw new Error('OneBot rejected second segment'); } };
  assert.equal(await commands.handleSongLibraryCommand(base), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(lines[0], /预留 1 次旧版赠送整首权益/);
  assert.match(lines.at(-1), /1 次旧版赠送权益预留/);
  assert.doesNotMatch(lines.at(-1), /3\.00 元/);
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 0, reserved: 1, available: 1 });
  attempt = 2;
  assert.equal(await commands.handleSongLibraryCommand(base), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 1, reserved: 0, available: 1 });
  assert.match(lines.at(-1), /已核销 1 次旧版赠送整首权益/);
  assert.doesNotMatch(lines.at(-1), /扣 3\.00 元/);
  assert.equal(sends, 3, 'resume skips the already confirmed segment');
  assert.equal(library.getVerifiedCreditBalance('1060100883'), 0, 'grant does not appear as verified cash');
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
