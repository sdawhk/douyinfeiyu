import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRAME_SIZE = Math.floor(144 * 128_000 / 44_100);
const FRAMES = 1150;

test('the same QQ song command is claimed once across both bridge connections', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'song-command-claim-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const first = await import(`../src/song-library.mjs?claim-first=${Date.now()}`);
  const second = await import(`../src/song-library.mjs?claim-second=${Date.now()}`);
  t.after(() => { first.closeSongLibraryForTests(); second.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  assert.equal(first.claimSongCommandEvent({ chatKey: 'group:839367702', senderId: '1668389572', messageId: 'qq-123' }), true);
  assert.equal(second.claimSongCommandEvent({ chatKey: 'g839367702', senderId: '1668389572', messageId: 'qq-123' }), false);
  assert.equal(second.claimSongCommandEvent({ chatKey: 'g839367702', senderId: '1668389572', messageId: 'qq-124' }), true,
    'a new QQ message may deliberately request the song again');
});

test('song catalog validates 30-second media and applies persistent global quota/locks', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'song-library-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?test=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; });

  const audio = path.join(temp, 'preview.mp3');
  const frames = Buffer.alloc(FRAME_SIZE * FRAMES);
  for (let index = 0; index < FRAMES; index++) frames.writeUInt32BE(0xfffb9000, index * FRAME_SIZE);
  writeFileSync(audio, frames);
  assert.ok(Math.abs(library.inspectMp3Duration(frames) - 30) < 0.1);
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10]);
  assert.ok(Math.abs(library.inspectMp3Duration(Buffer.concat([id3Header, Buffer.alloc(10), frames])) - 30) < 0.1);
  const vbrFrames = [];
  let vbrBytes = 0;
  for (let index = 0; index < FRAMES; index++) {
    const bitrateIndex = index % 2 ? 10 : 9;
    const frameLength = Math.floor(144 * (bitrateIndex === 9 ? 128_000 : 160_000) / 44_100);
    const frame = Buffer.alloc(frameLength);
    frame.writeUInt32BE((0xfffb0000 | (bitrateIndex << 12)) >>> 0);
    vbrFrames.push(frame);
    vbrBytes += frameLength;
  }
  const vbrAudio = Buffer.concat(vbrFrames, vbrBytes);
  assert.ok(Math.abs(library.inspectMp3Duration(vbrAudio) - 30) < 0.1);
  assert.equal(library.inspectMp3Duration(frames.subarray(0, -200)), null, 'a truncated final frame must be rejected');
  assert.equal(library.registerSongOutput({ file: audio, title: '测试歌曲', query: '测试歌曲', mode: 'ai', startSeconds: 30, seconds: 30 }, { decodeImpl: () => true }), true);
  assert.equal(library.registerSongOutput({ file: audio, title: '解码失败样本', query: '坏样本', mode: 'ai', seconds: 30 }, { decodeImpl: () => false }), false);
  assert.equal(library.listSongs().total, 1);
  const song = library.listSongs().songs[0];
  assert.equal(song.title, '测试歌曲');
  assert.ok(Buffer.isBuffer(library.getVerifiedSongPreview(song.song_id).audio));

  const first = library.reserveFreePreview({ chatKey: 'g12345', senderId: '11111', songId: song.song_id, now: 1_800_000_000_000 });
  assert.equal(first.ok, true);
  assert.equal(library.reserveFreePreview({ chatKey: 'g12345', senderId: '22222', songId: song.song_id, now: 1_800_000_000_001 }).reason, 'conversation-busy');
  assert.equal(library.settleFreePreview(first.requestId, 'failed'), true);
  const retry = library.reserveFreePreview({ chatKey: 'g12345', senderId: '22222', songId: song.song_id, now: 1_800_000_000_002 });
  assert.equal(retry.ok, true);
  assert.equal(library.settleFreePreview(retry.requestId, 'sent'), true);

  library.closeSongLibraryForTests();
  const recovered = await import(`../src/song-library.mjs?recovery=${Date.now()}`);
  const stale = recovered.reserveFreePreview({ chatKey: 'p33333', senderId: '33333', songId: song.song_id, now: 1_800_000_000_000 });
  assert.equal(stale.ok, true);
  assert.equal(recovered.reconcilePreviewReservations({ now: 1_800_000_180_001, staleAfterMs: 120_000 }), 1);
  assert.equal(recovered.reserveFreePreview({ chatKey: 'p33333', senderId: '33333', songId: song.song_id, now: 1_800_000_180_002 }).reason, 'conversation-busy');
  assert.equal(recovered.resolveUncertainPreview(stale.requestId, 'failed'), true);

  recovered.closeSongLibraryForTests();
  const quotaLib = await import(`../src/song-library.mjs?quota=${Date.now()}`);
  const anchor = Date.UTC(2026, 9, 26, 16, 0, 0);
  for (let i = 0; i < 3; i++) {
    const reservation = quotaLib.reserveFreePreview({ chatKey: `g${10000 + i}`, senderId: `${10000 + i}`, songId: song.song_id, now: anchor });
    assert.equal(reservation.ok, true);
    assert.equal(quotaLib.settleFreePreview(reservation.requestId, 'sent'), true);
  }
  assert.equal(quotaLib.reserveFreePreview({ chatKey: 'p80000', senderId: '80000', songId: song.song_id, now: anchor }).reason, 'rolling-limit');
  for (let i = 3; i < 30; i++) {
    const now = anchor + i * 11 * 60_000;
    const reservation = quotaLib.reserveFreePreview({ chatKey: `g${10000 + i}`, senderId: `${10000 + i}`, songId: song.song_id, now });
    assert.equal(reservation.ok, true);
    assert.equal(quotaLib.settleFreePreview(reservation.requestId, 'sent'), true);
  }
  assert.equal(quotaLib.reserveFreePreview({ chatKey: 'g90000', senderId: '90000', songId: song.song_id, now: anchor + 30 * 11 * 60_000 }).reason, 'daily-limit');
  assert.equal(quotaLib.reserveFreePreview({ chatKey: 'p90001', senderId: '90001', songId: song.song_id, now: anchor + 24 * 60 * 60_000 }).ok, true, 'the UTC+8 daily quota resets at local midnight');
  quotaLib.closeSongLibraryForTests();
});

test('red packet candidates remain unverified until one atomic owner approval', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'red-packet-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?red-packet-test=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });

  assert.equal(library.hasRedPacketMarker([{ type: 'text', data: { text: '[QQ红包]' } }]), false);
  const canonical = '[QQ红包]请使用新版手机QQ查收红包。';
  assert.equal(library.hasRedPacketMarker([{ type: 'text', data: { text: canonical } }]), true);
  assert.equal(library.hasRedPacketMarker([{ type: 'text', data: { text: `${canonical} 请查收` } }]), false);
  assert.equal(library.hasRedPacketMarker([{ type: 'text', data: { text: '有人发了QQ红包，快去看' } }]), false);
  assert.equal(library.hasRedPacketMarker([{ type: 'text', data: { text: canonical } }, { type: 'text', data: { text: 'x' } }]), false);
  assert.equal(library.hasRedPacketMarker([], canonical), true);
  assert.equal(library.hasRedPacketMarker([{ type: 'redbag', data: {} }]), true);
  const args = { botId: '90000', messageId: 'msg-1', senderId: '80000', chatKey: 'group:70000', now: 1_800_000_000_000 };
  const candidate = library.recordRedPacketCandidate(args);
  assert.equal(candidate.status, 'pending');
  assert.equal(library.recordRedPacketCandidate(args).candidate_id, candidate.candidate_id);
  assert.equal(library.claimRedPacketCandidateNotification(candidate.candidate_id, { now: args.now + 1000 }), true);
  assert.equal(library.settleRedPacketCandidateNotification(candidate.candidate_id, 'sent'), true);
  const cooledCandidate = library.recordRedPacketCandidate({ ...args, messageId: 'msg-2', now: args.now + 10_000 });
  assert.equal(library.claimRedPacketCandidateNotification(cooledCandidate.candidate_id, { now: args.now + 10_000 }), false);
  assert.equal(library.listPendingRedPacketCandidates().find((item) => item.candidate_id === cooledCandidate.candidate_id).notification_status, 'suppressed');
  const laterCandidate = library.recordRedPacketCandidate({ ...args, messageId: 'msg-3', now: args.now + 40_000 });
  assert.equal(library.claimRedPacketCandidateNotification(laterCandidate.candidate_id, { now: args.now + 40_000 }), true);
  assert.equal(library.settleRedPacketCandidateNotification(laterCandidate.candidate_id, 'failed'), true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 0);
  assert.equal(library.approveRedPacketCandidate({ candidateId: candidate.candidate_id, amountCents: 125, receiptRef: 'wallet-record-1' }).ok, true);
  assert.equal(library.approveRedPacketCandidate({ candidateId: candidate.candidate_id, amountCents: 125, receiptRef: 'wallet-record-2' }).reason, 'not-pending');
  assert.equal(library.approveRedPacketCandidate({ candidateId: candidate.candidate_id, amountCents: 125, receiptRef: 'wallet-record-1' }).reason, 'not-pending');
  assert.equal(library.getVerifiedCreditBalance('80000'), 125);
  assert.equal(library.getVerifiedCreditBalance('90000'), 0);
});

test('paid song credits reserve atomically and charge once only after confirmed completion', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-order-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-test=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const candidate = library.recordRedPacketCandidate({ botId: '90000', messageId: 'paid-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: candidate.candidate_id, amountCents: 100, receiptRef: 'paid-credit-receipt' });
  const order = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '精确歌名', kind: 'full', now: 1000 });
  assert.equal(order.ok, true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 100, 'unit reservations do not rewrite verified cash ledger');
  assert.equal(library.getPaidSongUnitSummary('80000').available, 0, '100 cents convert to three reserved full-song units');
  assert.equal(library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:2', query: '别的歌', kind: 'preview', now: 1001 }).reason, 'insufficient-credit');
  assert.equal(library.updatePaidSongOrder(order.orderId, { status: 'processing' }), true);
  assert.equal(library.updatePaidSongOrder(order.orderId, { status: 'completed', confirmedSegments: 2, segmentCount: 3 }), false,
    'partial full song cannot settle');
  assert.equal(library.getPaidSongUnitSummary('80000').available, 0);
  assert.equal(library.updatePaidSongOrder(order.orderId, { status: 'failed' }), true);
  assert.equal(library.getPaidSongUnitSummary('80000').available, 3, 'definite failure releases the unit reservation');
  const retry = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '精确歌名', kind: 'full', now: 2000 });
  assert.equal(retry.ok, true);
  library.updatePaidSongOrder(retry.orderId, { status: 'processing' });
  assert.equal(library.updatePaidSongOrder(retry.orderId, { status: 'completed' }), false,
    'an empty full order cannot complete or charge');
  assert.equal(library.getPaidSongUnitSummary('80000').available, 0, 'the order reservation remains in place');
  assert.equal(library.savePaidSongSegments(retry.orderId, { sourceIdentity: 'stable-source', title: '精确歌名', segments: [
    ...Array.from({ length: 4 }, (_, segmentIndex) => ({ segmentIndex, startSeconds: segmentIndex * 30, seconds: 30, cachePath: `retry-${segmentIndex}.mp3` }))
  ] }), true);
  assert.equal(library.updatePaidSongOrder(retry.orderId, { status: 'completed', confirmedSegments: 4, segmentCount: 4 }), false,
    'recorded but unsent full segments cannot settle');
  for (let index = 0; index < 4; index++) { library.updatePaidSongSegment(retry.orderId, index, 'sending'); library.updatePaidSongSegment(retry.orderId, index, 'sent'); }
  assert.equal(library.updatePaidSongOrder(retry.orderId, { status: 'completed', confirmedSegments: 4, segmentCount: 4, sourceIdentity: 'stable-source', title: '精确歌名' }), true);
  assert.equal(library.getPaidSongOrder(retry.orderId).output_path, 'retry-0.mp3', 'completion preserves the persisted first-segment cache path');
  assert.equal(library.getVerifiedCreditBalance('80000'), 100, 'unit settlement leaves verified cash ledger intact');
  assert.equal(library.updatePaidSongOrder(retry.orderId, { status: 'completed', confirmedSegments: 4, segmentCount: 4 }), false,
    'completed order cannot be charged twice');
  const extraCandidate = library.recordRedPacketCandidate({ botId: '90000', messageId: 'credit-extra', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: extraCandidate.candidate_id, amountCents: 100, receiptRef: 'credit-extra-ref' });
  const uncertain = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:3', query: '核对歌曲', kind: 'preview', now: 3000 });
  library.savePaidSongSegments(uncertain.orderId, { sourceIdentity: 'stable-source-2', title: '核对歌曲', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 30, seconds: 30, cachePath: 'preview-cache.mp3' }
  ] });
  library.updatePaidSongSegment(uncertain.orderId, 0, 'sending');
  library.updatePaidSongSegment(uncertain.orderId, 0, 'uncertain');
  library.updatePaidSongOrder(uncertain.orderId, { status: 'uncertain' });
  assert.equal(library.listUncertainPaidSongOrders().some((entry) => entry.order_id === uncertain.orderId), true);
  assert.equal(library.resolvePaidSongOrder(uncertain.orderId, 'sent'), true, 'owner reconciliation settles a confirmed uncertain preview');
  assert.equal(library.getVerifiedCreditBalance('80000'), 200, 'owner reconciliation consumes units without changing cash ledger');
  assert.equal(library.resolvePaidSongOrder(uncertain.orderId, 'not_sent'), false, 'resolved order cannot be resolved twice');
  const fullCredit = library.recordRedPacketCandidate({ botId: '90000', messageId: 'full-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: fullCredit.candidate_id, amountCents: 100, receiptRef: 'full-credit-ref' });
  const full = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:4', query: '整首核对', kind: 'full', now: 4000 });
  assert.equal(library.savePaidSongSegments(full.orderId, { sourceIdentity: 'same-source-hash', title: '整首核对', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'chunk-0.mp3' },
    { segmentIndex: 1, startSeconds: 30, seconds: 12, cachePath: 'chunk-1.mp3' }
  ] }), true);
  library.updatePaidSongSegment(full.orderId, 0, 'sending');
  library.updatePaidSongSegment(full.orderId, 0, 'sent');
  library.updatePaidSongSegment(full.orderId, 1, 'sending');
  library.updatePaidSongSegment(full.orderId, 1, 'uncertain');
  library.updatePaidSongOrder(full.orderId, { status: 'uncertain', confirmedSegments: 1 });
  assert.equal(library.listUncertainPaidSongOrders().find((entry) => entry.order_id === full.orderId).uncertain_segment_index, 1);
  assert.equal(library.resolvePaidSongOrder(full.orderId, 'sent', { segmentIndex: 1 }), true);
  assert.equal(library.getVerifiedCreditBalance('80000'), 300, 'full confirmation settles units without a cash ledger debit');
  const previewCredit = library.recordRedPacketCandidate({ botId: '90000', messageId: 'empty-preview-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: previewCredit.candidate_id, amountCents: 100, receiptRef: 'empty-preview-credit-ref' });
  const emptyPreview = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:5', query: '空试听', kind: 'preview', now: 5000 });
  assert.equal(library.updatePaidSongOrder(emptyPreview.orderId, { status: 'completed' }), false,
    'a preview without persisted deliverable data cannot settle');
  assert.equal(library.getVerifiedCreditBalance('80000'), 400, 'empty preview order stays reserved in units and does not alter cash ledger');
});

test('mixable units use floor cash conversion, cumulative cents, grants, and atomic replacement of legacy gifts', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-unit-pool-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-unit-pool=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const approve = (amount, ref) => {
    const candidate = library.recordRedPacketCandidate({ botId: '90000', messageId: ref, senderId: '70000', chatKey: 'private:90000' });
    return library.approveRedPacketCandidate({ candidateId: candidate.candidate_id, amountCents: amount, receiptRef: ref });
  };
  approve(33, 'fraction-33');
  assert.equal(library.getPaidSongUnitSummary('70000').cashUnits, 0, '33 cents cannot round up to one unit');
  approve(1, 'fraction-1');
  assert.equal(library.getPaidSongUnitSummary('70000').cashUnits, 1, 'the remaining cent completes the first unit');
  approve(66, 'to-100');
  assert.equal(library.getPaidSongUnitSummary('70000').cashUnits, 3, '100 cents yield exactly three units');
  approve(400, 'to-500');
  assert.equal(library.getPaidSongUnitSummary('70000').cashUnits, 15, '500 cents yield exactly fifteen units');

  library.grantPaidSongUnits({ grantId: 'mix-two', senderId: '70000', unitCount: 2, sourceNote: 'test gift', reportedAmountCents: 0 });
  const mixed = library.reservePaidSongOrder({ senderId: '70000', chatKey: 'mix:1', query: 'mixed full', kind: 'full', now: 1000 });
  assert.equal(mixed.creditSource, 'units');
  assert.equal(mixed.unitCost, 3, 'cash and gift units share one fungible pool');
  assert.equal(library.getPaidSongUnitSummary('70000').available, 14);
  assert.equal(library.updatePaidSongOrder(mixed.orderId, { status: 'failed' }), true);
  assert.equal(library.getPaidSongUnitSummary('70000').available, 17, 'definite failure releases the complete mixed reservation');

  const old = { grantId: 'xiasheng-legacy-two', senderId: '1060100883', count: 2,
    sourceNote: '主人陈述此前 5 元红包，金额未由适配器核实；赠送两次整首权益', reportedAmountCents: 500, now: 1 };
  library.grantPaidFullSongEntitlement(old);
  const replacement = { oldGrantId: old.grantId, grantId: 'xiasheng-units-15', senderId: old.senderId, unitCount: 15,
    sourceNote: '主人陈述此前 5 元红包，金额未由适配器核实；替换为 15 个点歌单位', reportedAmountCents: 500, now: 2 };
  assert.deepEqual(library.replacePaidFullSongGrantWithUnits(replacement), { ok: true, duplicate: false, grantId: replacement.grantId });
  assert.deepEqual(library.replacePaidFullSongGrantWithUnits(replacement), { ok: true, duplicate: true, grantId: replacement.grantId });
  assert.equal(library.getPaidFullSongEntitlementSummary(old.senderId).available, 0, 'revoked legacy gift is no longer spendable');
  assert.equal(library.getPaidSongUnitSummary(old.senderId).available, 15);
  assert.equal(library.getVerifiedCreditBalance(old.senderId), 0, 'reported gift provenance never enters verified cash ledger');
  const giftFull = library.reservePaidSongOrder({ senderId: old.senderId, chatKey: 'gift:1', query: 'five dollar equivalent', kind: 'full', now: 3 });
  assert.equal(giftFull.creditSource, 'units');
  assert.equal(giftFull.unitCost, 3);
  assert.equal(library.getPaidSongUnitSummary(old.senderId).available, 12, 'one full song uses three of fifteen units');
  library.savePaidSongSegments(giftFull.orderId, { sourceIdentity: 'gift-source', title: 'five dollar equivalent', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'gift-unit-0.mp3' },
    { segmentIndex: 1, startSeconds: 30, seconds: 20, cachePath: 'gift-unit-1.mp3' }
  ] });
  library.updatePaidSongSegment(giftFull.orderId, 0, 'sending');
  library.updatePaidSongSegment(giftFull.orderId, 0, 'sent');
  library.updatePaidSongSegment(giftFull.orderId, 1, 'sending');
  library.updatePaidSongSegment(giftFull.orderId, 1, 'uncertain');
  library.updatePaidSongOrder(giftFull.orderId, { status: 'uncertain', confirmedSegments: 1 });
  assert.equal(library.resolvePaidSongOrder(giftFull.orderId, 'sent', { segmentIndex: 1 }), true);
  assert.equal(library.getPaidSongUnitSummary(old.senderId).consumed, 3, 'owner reconciliation consumes the unit reservation once all segments are confirmed');
  assert.equal(library.resolvePaidSongOrder(giftFull.orderId, 'sent', { segmentIndex: 1 }), false, 'reconciliation cannot consume the same units twice');
  assert.equal(library.getVerifiedCreditBalance(old.senderId), 0, 'unit settlement leaves reported gift out of verified cash ledger');
});

test('partial paid orders are atomically claimed for a single resume attempt', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-resume-claim-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-resume-claim=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const credit = library.recordRedPacketCandidate({ botId: '90000', messageId: 'resume-claim-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: credit.candidate_id, amountCents: 300, receiptRef: 'resume-claim-ref' });
  const order = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '可续传歌', kind: 'full', now: 1000, processPid: -1 });
  library.savePaidSongSegments(order.orderId, { sourceIdentity: 'stable', title: '可续传歌', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'chunk-0.mp3' },
    { segmentIndex: 1, startSeconds: 30, seconds: 30, cachePath: 'chunk-1.mp3' }
  ] });
  library.updatePaidSongSegment(order.orderId, 0, 'sending');
  library.updatePaidSongSegment(order.orderId, 0, 'sent');
  library.updatePaidSongOrder(order.orderId, { status: 'partial', confirmedSegments: 1 });
  const first = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '可续传歌', kind: 'full', now: 2000 });
  assert.equal(first.resume, true);
  assert.equal(library.getPaidSongOrder(order.orderId).status, 'processing');
  assert.notEqual(library.getPaidSongOrder(order.orderId).process_pid, -1, 'resume claim adopts the current live process owner');
  const second = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '可续传歌', kind: 'full', now: 2001 });
  assert.deepEqual(second, { ok: false, reason: 'conversation-busy' }, 'a second resume claimant cannot run concurrently');
});

test('resolving one of two uncertain full-song segments keeps the other segment locked', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-two-uncertain-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-two-uncertain=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const credit = library.recordRedPacketCandidate({ botId: '90000', messageId: 'two-uncertain-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: credit.candidate_id, amountCents: 300, receiptRef: 'two-uncertain-ref' });
  const order = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '双不确定歌', kind: 'full', now: 1000 });
  library.savePaidSongSegments(order.orderId, { sourceIdentity: 'stable', title: '双不确定歌', voiceVariant: 'rvc:0', segments: [
    ...Array.from({ length: 3 }, (_, segmentIndex) => ({ segmentIndex, startSeconds: segmentIndex * 30, seconds: 30, cachePath: `chunk-${segmentIndex}.mp3` }))
  ] });
  library.updatePaidSongSegment(order.orderId, 0, 'sending');
  library.updatePaidSongSegment(order.orderId, 0, 'sent');
  for (const index of [1, 2]) { library.updatePaidSongSegment(order.orderId, index, 'sending'); library.updatePaidSongSegment(order.orderId, index, 'uncertain'); }
  library.updatePaidSongOrder(order.orderId, { status: 'uncertain', confirmedSegments: 1 });
  assert.equal(library.resolvePaidSongOrder(order.orderId, 'sent', { segmentIndex: 1 }), true);
  assert.equal(library.getPaidSongOrder(order.orderId).status, 'uncertain', 'remaining uncertain segment keeps order frozen');
  assert.equal(library.listUncertainPaidSongOrders().find((item) => item.order_id === order.orderId).uncertain_segment_index, 2);
  assert.equal(library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '双不确定歌', kind: 'full', now: 2000 }).reason,
    'conversation-busy', 'unresolved delivery cannot be resumed or resent');
  assert.equal(library.resolvePaidSongOrder(order.orderId, 'not_sent', { segmentIndex: 2 }), true);
  assert.equal(library.getPaidSongOrder(order.orderId).status, 'partial', 'order becomes resumable only after every uncertain segment is resolved');
  assert.equal(library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:1', query: '双不确定歌', kind: 'full', now: 2001 }).resume, true);
});

test('dead-process paid orders recover immediately while current-process orders stay untouched', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-crash-recovery-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-crash-recovery=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const credit = library.recordRedPacketCandidate({ botId: '90000', messageId: 'crash-recovery-credit', senderId: '80000', chatKey: 'private:90000' });
  library.approveRedPacketCandidate({ candidateId: credit.candidate_id, amountCents: 900, receiptRef: 'crash-recovery-ref' });
  const dead = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:dead', query: '崩溃中订单', kind: 'full', now: 1000, processPid: -1 });
  library.savePaidSongSegments(dead.orderId, { sourceIdentity: 'stable', title: '崩溃中订单', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'dead-0.mp3' },
    { segmentIndex: 1, startSeconds: 30, seconds: 30, cachePath: 'dead-1.mp3' }
  ] });
  library.updatePaidSongSegment(dead.orderId, 0, 'sending');
  const alive = library.reservePaidSongOrder({ senderId: '80000', chatKey: 'group:alive', query: '仍在制作', kind: 'full', now: 1001 });
  library.savePaidSongSegments(alive.orderId, { sourceIdentity: 'live-source', title: '仍在制作', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'live-0.mp3' }
  ] });
  library.updatePaidSongSegment(alive.orderId, 0, 'sending');
  library.listUncertainPaidSongOrders();
  assert.equal(library.getPaidSongOrder(dead.orderId).status, 'uncertain', 'dead-process sending segment is frozen for owner reconciliation');
  assert.equal(library.listPaidSongSegments(dead.orderId)[0].status, 'uncertain');
  assert.equal(library.getPaidSongOrder(alive.orderId).status, 'processing', 'live process order is not changed by recovery');
  assert.equal(library.listPaidSongSegments(alive.orderId)[0].status, 'sending');
});

test('owner-granted full-song entitlements are idempotent, separately reserved, and consumed only on full confirmation', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'paid-song-grant-test-'));
  process.env.DSH_SONG_LIBRARY_DB = path.join(temp, 'library.sqlite');
  const library = await import(`../src/song-library.mjs?paid-grant=${Date.now()}`);
  t.after(() => { library.closeSongLibraryForTests(); delete process.env.DSH_SONG_LIBRARY_DB; rmSync(temp, { recursive: true, force: true }); });
  const grant = { grantId: 'owner-grant-xiasheng-2-full-20261027', senderId: '1060100883', count: 2,
    sourceNote: '主人陈述此前 5 元红包，金额未由适配器核实；主人赠送 2 次整首点歌权益', reportedAmountCents: 500, now: 1000 };
  assert.equal(library.grantPaidFullSongEntitlement(grant).duplicate, false);
  assert.deepEqual(library.grantPaidFullSongEntitlement(grant), { ok: true, duplicate: true, grantId: grant.grantId });
  assert.equal(library.grantPaidFullSongEntitlement({ ...grant, count: 3 }).reason, 'grant-id-conflict');
  assert.equal(library.getVerifiedCreditBalance('1060100883'), 0, 'owner statement is not entered as verified cash');
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 0, reserved: 0, available: 2 });

  const failed = library.reservePaidSongOrder({ senderId: '1060100883', chatKey: 'group:1', query: '失败释放权益', kind: 'full', now: 2000 });
  assert.equal(failed.creditSource, 'grant');
  assert.equal(failed.grantId, grant.grantId);
  assert.equal(failed.priceCents, 0);
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 0, reserved: 1, available: 1 });
  library.updatePaidSongOrder(failed.orderId, { status: 'failed' });
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 0, reserved: 0, available: 2 });

  const completed = library.reservePaidSongOrder({ senderId: '1060100883', chatKey: 'group:2', query: '权益完成路径', kind: 'full', now: 3000 });
  library.savePaidSongSegments(completed.orderId, { sourceIdentity: 'grant-source', title: '权益完成路径', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'grant-0.mp3' },
    { segmentIndex: 1, startSeconds: 30, seconds: 20, cachePath: 'grant-1.mp3' }
  ] });
  for (const index of [0, 1]) { library.updatePaidSongSegment(completed.orderId, index, 'sending'); library.updatePaidSongSegment(completed.orderId, index, 'sent'); }
  assert.equal(library.updatePaidSongOrder(completed.orderId, { status: 'completed', confirmedSegments: 2, segmentCount: 2 }), true);
  assert.equal(library.getVerifiedCreditBalance('1060100883'), 0, 'grant settlement leaves cash ledger unchanged');
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 1, reserved: 0, available: 1 });

  const reconciled = library.reservePaidSongOrder({ senderId: '1060100883', chatKey: 'group:3', query: '权益核对路径', kind: 'full', now: 4000 });
  library.savePaidSongSegments(reconciled.orderId, { sourceIdentity: 'grant-source-2', title: '权益核对路径', voiceVariant: 'rvc:0', segments: [
    { segmentIndex: 0, startSeconds: 0, seconds: 30, cachePath: 'grant-2.mp3' }
  ] });
  library.updatePaidSongSegment(reconciled.orderId, 0, 'sending');
  library.updatePaidSongSegment(reconciled.orderId, 0, 'uncertain');
  library.updatePaidSongOrder(reconciled.orderId, { status: 'uncertain' });
  assert.equal(library.resolvePaidSongOrder(reconciled.orderId, 'sent', { segmentIndex: 0 }), true);
  assert.equal(library.getVerifiedCreditBalance('1060100883'), 0, 'manual full-song reconciliation consumes entitlement without a cash debit');
  assert.deepEqual(library.getPaidFullSongEntitlementSummary('1060100883'), { granted: 2, consumed: 2, reserved: 0, available: 0 });
});
