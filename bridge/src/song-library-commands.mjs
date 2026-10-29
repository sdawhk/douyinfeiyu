import {
  getPaidSongUnitSummary, getPaidFullSongEntitlementSummary, getVerifiedSongPreview, listSongs,
  listPendingRedPacketCandidates, listUncertainPreviews, ownerLedgerSummary, redPacketCapabilityStatus,
  approveRedPacketCandidate, rejectRedPacketCandidate,
  claimRedPacketCandidateNotification, hasRedPacketMarker, recordRedPacketCandidate, settleRedPacketCandidateNotification,
  claimSongCommandEvent, reconcilePreviewReservations, refreshSongLibrary, reserveFreePreview,
  resolveUncertainPreview, settleFreePreview, reservePaidSongOrder,
  updatePaidSongOrder, registerSongOutput, listUncertainPaidSongOrders, resolvePaidSongOrder,
  savePaidSongSegments, listPaidSongSegments, getPaidSongOrder, updatePaidSongSegment
} from './song-library.mjs';

let libraryLoaded = false;
let reservationsReconciled = false;
const playlistSnapshots = new Map();
const PLAYLIST_SNAPSHOT_TTL_MS = 30 * 60_000;
const lastChatterByChat = new Map();
const SONG_CHATTER = {
  playlist: [
    '挑首顺耳的听听吧，我继续练唱，争取把白饭也吃出庆功宴的感觉。',
    '歌单更新好啦，今晚的节拍和热白饭好像还挺配。',
    '慢慢挑，我先在心里跟着副歌哼两句，等会儿再去惦记白饭。'
  ],
  preview: [
    '这段副歌还挺上头，听完我都想给白饭配个节拍。',
    '先听听合不合胃口；我唱得开心，白饭都像更香了一点。',
    '这首的旋律我能在脑子里多循环一会儿，正好配一碗白饭。'
  ],
  full: [
    '这一整首唱下来真畅快，我先歇口气，等会儿再去找白饭。',
    '副歌还在脑子里转呢，感觉今天这碗白饭能吃得特别香。',
    '唱完整首心情都亮了些，配点热白饭刚刚好。'
  ],
  replay: [
    '又听一遍也不腻，熟悉的旋律配白饭总让人安心。',
    '这首再放一次，副歌还是很有劲；我都想跟着节拍去盛饭了。',
    '熟歌就是耐听，像热白饭一样，简单但让人满足。'
  ],
  generated: [
    '这是刚做出来的新旋律，我还在回味，差点忘了白饭要趁热吃。',
    '新歌落地啦，愿这段旋律和热白饭一样，听着就让人心里踏实。',
    '我得把这首再哼一会儿，今天的白饭说不定都能多吃半碗。'
  ]
};

export function songChatterLine(key, kind = 'preview') {
  const choices = SONG_CHATTER[kind] ?? SONG_CHATTER.preview;
  const chatKey = String(key ?? '');
  const previous = lastChatterByChat.get(chatKey);
  const available = choices.filter((line) => line !== previous);
  const line = available[Math.floor(Math.random() * available.length)] ?? choices[0];
  lastChatterByChat.set(chatKey, line);
  if (lastChatterByChat.size > 500) lastChatterByChat.delete(lastChatterByChat.keys().next().value);
  return line;
}

function readPlaylistSnapshot(key) {
  const now = Date.now();
  const cached = playlistSnapshots.get(key);
  if (cached && cached.expiresAt > now) return cached.songs;
  if (cached) playlistSnapshots.delete(key);
  const first = listSongs({ offset: 0, limit: 50 });
  const songs = [...first.songs];
  for (let offset = first.limit; offset < first.total; offset += first.limit) {
    songs.push(...listSongs({ offset, limit: first.limit }).songs);
  }
  playlistSnapshots.set(key, { songs, expiresAt: now + PLAYLIST_SNAPSHOT_TTL_MS });
  if (playlistSnapshots.size > 200) {
    const oldestKey = playlistSnapshots.keys().next().value;
    if (oldestKey) playlistSnapshots.delete(oldestKey);
  }
  return songs;
}

function cachePlaylistSnapshot(key) {
  const songs = readPlaylistSnapshot(key);
  playlistSnapshots.set(key, { songs, expiresAt: Date.now() + PLAYLIST_SNAPSHOT_TTL_MS });
  return songs;
}

function isFreeGroupFullSong(query) {
  const normalized = String(query ?? '').normalize('NFKC').toLowerCase()
    .replace(/雨愛/g, '雨爱').replace(/司[鳳風风]/g, '司凤')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  return normalized === '雨爱司凤版';
}

export function normalizeSongCommandText(text, { selfNickname = '', selfQQ = '', hasBotMention = false } = {}) {
  const value = String(text ?? '').trim();
  const mention = value.match(/^@([^\s@]+)\s*/);
  let normalized = value;
  if (mention) {
    const name = mention[1].toLocaleLowerCase();
    const recognized = hasBotMention || name === String(selfNickname).toLocaleLowerCase()
      || name === String(selfQQ) || name === `qq${selfQQ}`;
    if (recognized) normalized = value.slice(mention[0].length).trim();
  }
  return normalized.replace(/^(新歌试听|唱完整首)(?=\S)(.+)$/u, '$1 $2');
}

export function isSongLibraryCommand(text) {
  const command = normalizeSongCommandText(text);
  return /^(?:歌单(?:\s+\d{1,4})?|试听\s*(?:\d{1,4}|[a-f0-9]{12})|新歌试听(?:\s+.+)?|唱完整首(?:\s+.+)?|好友列表(?:\s+\d{1,3})?|红包账本|红包待核验|红包通过\s+[a-f0-9]{64}\s+\d+\s+\S+|红包拒绝\s+[a-f0-9]{64}|余额|QQ\s*钱包余额|试听待核对|核对试听\s+[a-f0-9]{64}\s+(?:已发送|未发送)|付费订单待核对|核对付费\s+[a-f0-9]{64}(?:\s+\d+)?\s+(?:已发送|未发送)|我的点歌额度)$/i.test(command);
}

export function shouldRouteSongLibraryCommand(text, { replyEnabled = true, muted = false } = {}) {
  return isSongLibraryCommand(text) && replyEnabled === true && muted !== true;
}

export function shouldBlockLegacySongRequest(isOwner, mode = 'ai') {
  return !isOwner && mode !== 'search';
}

export async function handleRedPacketCandidateNotice({ event, botId, chatKey, ownerIds, sendPrivate }) {
  if (!hasRedPacketMarker(event?.message, event?.raw_message)) return false;
  const candidate = recordRedPacketCandidate({
    botId, messageId: event?.message_id ?? event?.msg_id ?? event?.message_seq,
    senderId: event?.user_id ?? event?.sender?.user_id, chatKey
  });
  if (!candidate || !claimRedPacketCandidateNotification(candidate.candidate_id)) return Boolean(candidate);
  const humanOwners = [...new Set((ownerIds ?? []).map(String).filter((id) => id && id !== String(botId)))];
  if (!humanOwners.length) {
    settleRedPacketCandidateNotification(candidate.candidate_id, 'pending');
    console.error('[red-packet] candidate pending; no human owner QQ configured');
    return true;
  }
  const message = `收到一条疑似 QQ 红包提示，候选 ${candidate.candidate_id}。发送者 ${candidate.sender_id}，会话 ${candidate.chat_key}。适配器只提供固定格式文本，内容可能伪造；这不是到账证明。请核对机器人 QQ 账号实际收款记录后再决定是否记账。`;
  let sent = false;
  for (const ownerId of humanOwners) {
    try { await sendPrivate(ownerId, message); sent = true; }
    catch (error) { console.error(`[red-packet] owner notification failed owner=${ownerId}:`, error?.message ?? error); }
  }
  settleRedPacketCandidateNotification(candidate.candidate_id, sent ? 'sent' : 'failed');
  return true;
}

function uncertainDelivery(error) {
  if (error?.definiteDeliveryFailure === true) return false;
  return error?.uncertain === true || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || /timeout|timed out|aborted|econnreset|econnrefused|epipe|fetch failed|socket hang up/i.test(String(error?.message ?? error));
}

export async function handleSongLibraryCommand({
  text, key, senderId, sourceMessageId, isGroup, isOwner = false, botId = '',
  sendText, sendRecord, onSongDelivery = () => {}, getFriendList, refreshLibrary = refreshSongLibrary,
  makePaidPreview, makePaidFullSong, coverEnabled = false
}) {
  const command = normalizeSongCommandText(text);
  const listMatch = command.match(/^歌单(?:\s+(\d{1,4}))?$/);
  const previewMatch = command.match(/^试听\s*(\d{1,4}|[a-f0-9]{12})$/i);
  const paidMatch = /^(?:新歌试听(?:\s+.+)?|唱完整首(?:\s+.+)?)$/.test(command);
  const paidPreviewMatch = command.match(/^新歌试听\s+(.+)$/);
  const paidFullMatch = command.match(/^唱完整首\s+(.+)$/);
  const friendMatch = command.match(/^好友列表(?:\s+(\d{1,3}))?$/);
  const ownerQuery = /^(?:红包账本|余额|QQ\s*钱包余额)$/.test(command);
  const packetPendingCommand = command === '红包待核验';
  const packetApprove = command.match(/^红包通过\s+([a-f0-9]{64})\s+(\d+)\s+(\S+)$/i);
  const packetReject = command.match(/^红包拒绝\s+([a-f0-9]{64})$/i);
  const pendingCommand = command === '试听待核对';
  const resolveMatch = command.match(/^核对试听\s+([a-f0-9]{64})\s+(已发送|未发送)$/i);
  const paidPending = command === '付费订单待核对';
  const paidResolve = command.match(/^核对付费\s+([a-f0-9]{64})(?:\s+(\d+))?\s+(已发送|未发送)$/i);
  const quotaCommand = command === '我的点歌额度';
  if (!listMatch && !previewMatch && !paidMatch && !friendMatch && !ownerQuery
      && !packetPendingCommand && !packetApprove && !packetReject
      && !pendingCommand && !resolveMatch && !paidPending && !paidResolve && !quotaCommand) return false;
  if (!claimSongCommandEvent({ chatKey: key, senderId, messageId: sourceMessageId })) return true;

  const say = (message) => sendText(message);
  const ensureLibrary = () => {
    if (!libraryLoaded) {
      const scan = refreshLibrary();
      libraryLoaded = true;
      return scan;
    }
    return null;
  };
  const reconcile = () => {
    if (reservationsReconciled) return 0;
    reservationsReconciled = true;
    return reconcilePreviewReservations();
  };

  if (listMatch) {
    try {
      const scan = ensureLibrary();
      if (scan) console.log(`[song-library] indexed=${scan.indexed} rejected=${scan.rejected}`);
      const page = Math.max(1, Number(listMatch[1] || 1));
      const result = listSongs({ offset: (page - 1) * 10, limit: 10 });
      if (!result.total) await say('歌单里还没有可核验的 30 秒试听。音频需通过完整解码、时长和哈希检查。');
      else {
        const pages = Math.max(1, Math.ceil(result.total / result.limit));
        if (page > pages) await say(`歌单共 ${result.total} 首，第 ${pages} 页是最后一页。`);
        else {
          const snapshot = cachePlaylistSnapshot(key);
          const pageSongs = snapshot.slice((page - 1) * 10, page * 10);
          const lines = pageSongs.map((song, index) => `${(page - 1) * 10 + index + 1}. ${song.query || song.title}${song.variantCount > 1 ? `（另有 ${song.variantCount - 1} 个版本）` : ''}`);
          await say(`本地歌单 ${page}/${pages}（共 ${result.total} 首）\n${lines.join('\n')}\n试听序号：试听1、试听2……\n${songChatterLine(key, 'playlist')}`);
        }
      }
    } catch (error) {
      console.error('[song-library] list failed:', error?.message ?? error);
      await say('歌单读取暂时失败，请稍后再试。');
    }
    return true;
  }

  if (previewMatch) {
    reconcile();
    try {
      const scan = ensureLibrary();
      if (scan) console.log(`[song-library] indexed=${scan.indexed} rejected=${scan.rejected}`);
      let songId = previewMatch[1].toLowerCase();
      if (/^\d+$/.test(songId)) {
        const songs = playlistSnapshots.get(key)?.expiresAt > Date.now()
          ? playlistSnapshots.get(key).songs : readPlaylistSnapshot(key);
        const index = Number(songId) - 1;
        if (index < 0 || index >= songs.length) {
          await say(`歌单里没有第 ${songId} 首，请先发送“歌单”查看。`);
          return true;
        }
        songId = songs[index].song_id;
      }
      const song = getVerifiedSongPreview(songId);
      if (!song) { await say('这个编号没有可用的 30 秒试听文件，请刷新歌单后重试。'); return true; }
      // 已审核歌单试听对所有群友免费开放，不受每日和滚动额度限制。
      // 仍保留会话级并发锁，避免同一会话同时发送多段语音。
      const reservation = reserveFreePreview({ chatKey: key, senderId, songId, exemptFromQuota: true, now: Date.now() });
      if (!reservation.ok) {
        const message = reservation.reason === 'conversation-busy' ? '这个会话正在处理前一首试听，本轮只执行第一位点歌人的请求。'
          : '这首歌已不在可试听歌单里。';
        await say(message);
        return true;
      }
      try {
        await sendRecord(song.audio);
        onSongDelivery({ title: song.title, mode: 'playlist', status: 'sent', seconds: 30 });
        settleFreePreview(reservation.requestId, 'sent');
        await say(`《${song.title}》试听已发送，歌单试听免费，不限次数。${songChatterLine(key, 'preview')}`);
      } catch (error) {
        const uncertain = uncertainDelivery(error);
        onSongDelivery({ title: song.title, mode: 'playlist', status: uncertain ? 'uncertain' : 'failed', seconds: 30 });
        settleFreePreview(reservation.requestId, uncertain ? 'uncertain' : 'failed');
        console.error(`[song-library] preview delivery ${uncertain ? 'uncertain' : 'failed'} song=${songId}:`, error?.message ?? error);
        await say(uncertain
          ? '试听发送结果暂时无法确认，已暂停本会话后续试听，避免重复发送；请联系主人核对。'
          : '试听语音没有发送成功，免费次数已释放，请稍后重试。');
      }
    } catch (error) {
      console.error('[song-library] preview failed:', error?.message ?? error);
      await say('试听处理暂时失败，请稍后再试。');
    }
    return true;
  }

  if (quotaCommand) {
    const rights = getPaidFullSongEntitlementSummary(senderId);
    const units = getPaidSongUnitSummary(senderId);
    await say(`点歌单位：累计来源为核验金额折算 ${units.cashUnits}、赠送发放 ${units.grantedUnits}；已用 ${units.consumed}、预留 ${units.reserved}，可用 ${units.available}。100 分核验额度折算 3 单位；试听 1 单位，整首 3 单位；余分累计。旧整首赠送权益另计：可用 ${rights.available} 次、预留 ${rights.reserved} 次。${redPacketCapabilityStatus().reason}`);
    return true;
  }
  if (paidMatch) {
    const fullMatch = paidFullMatch;
    const requestedQuery = String(paidPreviewMatch?.[1] ?? fullMatch?.[1] ?? '').trim().slice(0, 80);
    if (!isOwner) {
      await say('群友可以免费、不限次数试听歌单里的歌曲；新歌点歌和整首制作目前仅主人可用。');
      return true;
    }
    if (!requestedQuery) { await say('请提供准确歌名，例如：新歌试听 <歌名>。'); return true; }
    const freeFullSong = Boolean(isGroup && fullMatch && isFreeGroupFullSong(requestedQuery));
    const query = freeFullSong ? '雨爱（司凤版）' : requestedQuery;
    if (!coverEnabled || (fullMatch ? typeof makePaidFullSong !== 'function' : typeof makePaidPreview !== 'function')) {
      await say('付费点歌当前未启用；需要开启现成歌曲翻唱。');
      return true;
    }
    const kind = fullMatch ? 'full' : 'preview';
    const order = reservePaidSongOrder({ senderId, chatKey: key, query, kind, free: freeFullSong });
    if (!order.ok) {
      await say(order.reason === 'conversation-busy' ? '这个会话已有点歌订单正在处理或待核对。'
        : order.reason === 'insufficient-credit' ? `可用点歌单位不足。当前可用 ${getPaidSongUnitSummary(senderId).available} 单位；${fullMatch ? '整首需 3 单位（1 元等值）' : '试听需 1 单位（约 1/3 元等值）'}。100 分核验额度折算 3 单位，余分累计。`
          : '这条点歌请求无效，请检查歌名后重试。');
      return true;
    }
    updatePaidSongOrder(order.orderId, { status: 'processing' });
    const reservationDescription = order.creditSource === 'promo' ? '主人专属免费曲目，不扣点歌单位'
      : order.creditSource === 'grant' ? '预留 1 次旧版赠送整首权益'
      : order.creditSource === 'units' ? `预留 ${order.unitCost} 个点歌单位（${order.unitCost === 3 ? '1 元等值' : '约 1/3 元等值'}）`
        : `预留 ${(order.priceCents / 100).toFixed(2)} 元历史现金额度`;
    try { await say(`已为《${query}》${reservationDescription}，正在${fullMatch ? '下载并制作整首流萤翻唱' : '制作 30 秒流萤翻唱试听'}。订单 ${order.orderId.slice(0, 12)}。`); }
    catch (error) { console.error(`[paid-song] reservation notice failed order=${order.orderId}:`, error?.message ?? error); }
    void (async () => {
      let deliveryAttempted = false;
      let currentSegment = null;
      let deliveryTitle = query;
      try {
        if (kind === 'preview') {
          const result = await makePaidPreview(query, order.orderId);
          if (!result || !Buffer.isBuffer(result.audio) || !result.title || !result.sourceIdentity) throw new Error('paid preview producer returned incomplete audio');
          deliveryTitle = result.title;
          if (!savePaidSongSegments(order.orderId, { sourceIdentity: result.sourceIdentity, title: result.title, voiceVariant: result.voiceVariant ?? '',
            segments: [{ segmentIndex: 0, startSeconds: result.startSeconds ?? 30, seconds: 30, cachePath: result.file ?? `order:${order.orderId}` }] })) throw new Error('paid order metadata could not be persisted');
          if (!updatePaidSongOrder(order.orderId, { status: 'processing', sourceIdentity: result.sourceIdentity, title: result.title, outputPath: result.file })
            || !updatePaidSongSegment(order.orderId, 0, 'sending')) throw new Error('paid preview could not enter sending state');
          deliveryAttempted = true;
          await sendRecord(result.audio);
          if (!updatePaidSongSegment(order.orderId, 0, 'sent')) { const error = new Error('confirmed preview could not be recorded'); error.uncertain = true; throw error; }
          const settled = updatePaidSongOrder(order.orderId, { status: 'completed', confirmedSegments: 1, segmentCount: 1,
            sourceIdentity: result.sourceIdentity, title: result.title, outputPath: result.file ?? '' });
          if (!settled) { const error = new Error('OneBot confirmed delivery but paid order settlement failed'); error.uncertain = true; throw error; }
          onSongDelivery({ title: result.title, mode: 'paid-preview', status: 'sent', seconds: 30 });
          let indexed = false;
          try { indexed = result.file ? registerSongOutput({ file: result.file, title: result.title, query,
            mode: 'ai', voiceVariant: result.voiceVariant ?? '', startSeconds: result.startSeconds ?? 30, seconds: 30 }) : false; }
          catch (error) { console.error(`[paid-song] catalog registration failed order=${order.orderId}:`, error?.message ?? error); }
          const settlement = order.creditSource === 'units' ? '已结算 1 个点歌单位（约 1/3 元等值）'
            : `已结算历史现金额度 ${(order.priceCents / 100).toFixed(2)} 元`;
          try { await say(`《${result.title}》付费试听已由 OneBot 确认发送，${settlement}。${indexed ? '已加入本地歌单。' : '音频已缓存，歌单核验未通过，暂不展示。'}${songChatterLine(key, 'preview')}`); }
          catch (error) { console.error(`[paid-song] completion notice failed order=${order.orderId}:`, error?.message ?? error); }
          return;
        }
        const savedOrder = order.resume ? getPaidSongOrder(order.orderId) : null;
        const resume = savedOrder ? { sourceIdentity: savedOrder.source_identity, title: savedOrder.title, voiceVariant: savedOrder.voice_variant,
          segments: listPaidSongSegments(order.orderId) } : null;
        const result = await makePaidFullSong(query, order.orderId, { resume });
        if (!result || !Array.isArray(result.segments) || !result.segments.length || !result.title || !result.sourceIdentity) throw new Error('paid full-song producer returned incomplete segments');
        deliveryTitle = result.title;
        const durableSegments = result.segments.map((segment) => ({ segmentIndex: segment.segmentIndex,
          startSeconds: segment.startSeconds, seconds: segment.seconds, cachePath: segment.cachePath }));
        if (!savePaidSongSegments(order.orderId, { sourceIdentity: result.sourceIdentity, title: result.title,
          voiceVariant: result.voiceVariant ?? '', segments: durableSegments })) {
          throw new Error('paid full-song segments could not be durably recorded');
        }
        if (!updatePaidSongOrder(order.orderId, { status: 'processing', sourceIdentity: result.sourceIdentity, title: result.title })) throw new Error('paid full-song order could not enter delivery');
        for (const segment of result.segments) {
          const state = listPaidSongSegments(order.orderId)[segment.segmentIndex];
          if (!state || state.segment_index !== segment.segmentIndex) throw new Error('paid segment index is not contiguous');
          if (state.status === 'sent') continue;
          if (state.status === 'uncertain') { updatePaidSongOrder(order.orderId, { status: 'uncertain' }); return; }
          currentSegment = segment.segmentIndex;
          if (!updatePaidSongSegment(order.orderId, currentSegment, 'sending')) throw new Error('paid segment could not enter sending state');
          deliveryAttempted = true;
          await sendRecord(segment.audio);
          if (!updatePaidSongSegment(order.orderId, currentSegment, 'sent')) { const error = new Error('confirmed segment could not be recorded'); error.uncertain = true; throw error; }
          const sentCount = listPaidSongSegments(order.orderId).filter((item) => item.status === 'sent').length;
          updatePaidSongOrder(order.orderId, { status: 'processing', confirmedSegments: sentCount });
          deliveryAttempted = false;
        }
        const segmentCount = result.segments.length;
        const settled = updatePaidSongOrder(order.orderId, { status: 'completed', confirmedSegments: segmentCount, segmentCount,
          sourceIdentity: result.sourceIdentity, title: result.title });
        if (!settled) { const error = new Error('all segments sent but order settlement failed'); error.uncertain = true; throw error; }
        onSongDelivery({ title: result.title, mode: 'paid-full', status: 'sent', seconds: result.segments.reduce((sum, item) => sum + (Number(item.seconds) || 0), 0) });
        let indexed = false;
        try { indexed = registerSongOutput({ file: durableSegments[0].cachePath, title: result.title, query,
          mode: 'ai', voiceVariant: result.voiceVariant ?? '', startSeconds: 0, seconds: 30 }); }
        catch (error) { console.error(`[paid-song] full catalog registration failed order=${order.orderId}:`, error?.message ?? error); }
        const settlementDescription = order.creditSource === 'promo' ? '本首为主人专属免费曲目，未扣点歌单位'
          : order.creditSource === 'grant' ? '已核销 1 次旧版赠送整首权益'
          : order.creditSource === 'units' ? '已结算 3 个点歌单位（1 元等值）' : `已结算历史现金额度 ${(order.priceCents / 100).toFixed(2)} 元`;
        try { await say(`《${result.title}》整首翻唱已由 OneBot 确认发送 ${segmentCount} 段，${settlementDescription}。${indexed ? '已加入本地歌单。' : '歌单核验未通过，暂不展示。'}${songChatterLine(key, 'full')}`); }
        catch (error) { console.error(`[paid-song] completion notice failed order=${order.orderId}:`, error?.message ?? error); }
      } catch (error) {
        const uncertain = deliveryAttempted && uncertainDelivery(error);
        if (kind === 'full') {
          if (uncertain && currentSegment != null) updatePaidSongSegment(order.orderId, currentSegment, 'uncertain');
          else if (currentSegment != null) updatePaidSongSegment(order.orderId, currentSegment, 'ready');
          const confirmed = listPaidSongSegments(order.orderId).filter((item) => item.status === 'sent').length;
          updatePaidSongOrder(order.orderId, { status: uncertain ? 'uncertain' : confirmed > 0 ? 'partial' : 'failed', confirmedSegments: confirmed });
        } else {
          if (currentSegment != null) updatePaidSongSegment(order.orderId, currentSegment, uncertain ? 'uncertain' : 'ready');
          else {
            const previewSegment = listPaidSongSegments(order.orderId)[0];
            if (previewSegment?.status === 'sending') updatePaidSongSegment(order.orderId, 0, uncertain ? 'uncertain' : 'ready');
          }
          updatePaidSongOrder(order.orderId, { status: uncertain ? 'uncertain' : 'failed' });
        }
        const confirmedSegments = kind === 'full' ? listPaidSongSegments(order.orderId).filter((item) => item.status === 'sent').length : 0;
        onSongDelivery({ title: deliveryTitle, mode: kind === 'full' ? 'paid-full' : 'paid-preview',
          status: uncertain ? 'uncertain' : confirmedSegments > 0 ? 'partial' : 'failed',
          detail: confirmedSegments ? `已确认 ${confirmedSegments} 段` : '' });
        console.error(`[paid-song] preview ${uncertain ? 'uncertain' : 'failed'} order=${order.orderId}:`, error?.message ?? error);
        await say(uncertain ? `《${query}》的发送结果无法确认；订单已冻结，不会自动重发或重复结算额度。订单 ${order.orderId} 请主人核对。`
          : kind === 'full' && listPaidSongSegments(order.orderId).some((item) => item.status === 'sent')
            ? `《${query}》整首分段发送中断，已保留已确认段进度和${order.creditSource === 'promo' ? '本首免费资格' : order.creditSource === 'grant' ? ' 1 次旧版赠送权益预留' : order.creditSource === 'units' ? ' 3 个点歌单位预留（1 元等值）' : ` ${order.priceCents / 100} 元历史现金额度预留`}。重新发送“唱完整首 ${query}”可从未确认段继续。订单 ${order.orderId.slice(0, 12)}。`
            : `《${query}》${kind === 'full' ? '整首翻唱' : '试听'}制作或发送失败，额度已释放，可以稍后安全重试。`);
      }
    })().catch((error) => console.error(`[paid-song] background task failed order=${order.orderId}:`, error?.message ?? error));
    return true;
  }

  if (paidPending || paidResolve) {
    if (!isOwner || isGroup || String(senderId) === String(botId)) {
      await say('付费订单状态核对只允许非机器人主人 QQ 私聊使用。');
      return true;
    }
    if (paidPending) {
      const pending = listUncertainPaidSongOrders({ limit: 30 });
      await say(pending.length
        ? `待核对付费订单（最多 30 条）：\n${pending.map((entry) => `${entry.order_id}｜用户 ${entry.sender_id}｜${entry.kind === 'preview' ? '新歌试听' : '整首'}｜${entry.query}｜已确认段 ${entry.confirmed_segments}/${entry.segment_count}${entry.uncertain_segment_index == null ? '' : `｜待核第 ${entry.uncertain_segment_index + 1} 段`}`).join('\n')}\n试听核对：核对付费 <订单ID> 已发送/未发送；整首核对：核对付费 <订单ID> <段号> 已发送/未发送`
        : '没有待核对的付费订单。');
    } else {
      const segmentIndex = paidResolve[2] == null ? null : Number(paidResolve[2]) - 1;
      const resolved = resolvePaidSongOrder(paidResolve[1], paidResolve[3] === '已发送' ? 'sent' : 'not_sent', { segmentIndex });
      await say(resolved ? `付费订单已按主人核实结果登记为${paidResolve[3]}。${paidResolve[3] === '已发送' ? '对应订单或分段已结算。' : '预留额度已释放或保留待续传。'}`
        : '订单不存在、状态不符或缺少安全结算所需的信息，未更改记录。');
    }
    return true;
  }

  if (pendingCommand || resolveMatch) {
    if (!isOwner || isGroup) {
      await say('发送状态核对只允许主人私聊使用。');
      return true;
    }
    reconcile();
    if (pendingCommand) {
      const pending = listUncertainPreviews({ limit: 20 });
      await say(pending.length
        ? `发送结果待核对（最多 20 条）：\n${pending.map((entry) => `${entry.request_id}｜${entry.sender_id}｜${entry.chat_key}｜歌曲 ${entry.song_id}`).join('\n')}\n核对后使用：核对试听 <请求ID> 已发送/未发送`
        : '没有待核对的试听发送记录。');
    } else {
      const resolved = resolveUncertainPreview(resolveMatch[1], resolveMatch[2] === '已发送' ? 'sent' : 'failed');
      await say(resolved ? `试听请求已标记为${resolveMatch[2]}。` : '没有找到这条待核对请求，记录未更改。');
    }
    return true;
  }

  if (packetPendingCommand || packetApprove || packetReject) {
    if (!isOwner || isGroup || String(senderId) === String(botId)) {
      await say('红包候选核对只允许非机器人主人 QQ 私聊使用。');
      return true;
    }
    if (packetPendingCommand) {
      const pending = listPendingRedPacketCandidates({ limit: 50 });
      await say(pending.length
        ? `待人工核实的疑似红包候选（最多 50 条）：\n${pending.map((entry) => `${entry.candidate_id}｜发送者 ${entry.sender_id}｜会话 ${entry.chat_key}`).join('\n')}\n确认在机器人 QQ 账号的实际收款记录后，按分核对并录入：红包通过 <候选ID> <实际到账分> <唯一回执引用>\n候选本身不代表已收款。`
        : '当前没有待核实的疑似红包候选。');
      return true;
    }
    if (packetReject) {
      await say(rejectRedPacketCandidate(packetReject[1])
        ? '疑似红包候选已拒绝，未记入额度。' : '没有找到待核实候选，记录未更改。');
      return true;
    }
    const cents = Number(packetApprove[2]);
    const approved = approveRedPacketCandidate({ candidateId: packetApprove[1], amountCents: cents, receiptRef: packetApprove[3] });
    await say(approved.ok
      ? `主人已根据机器人 QQ 账号实际收款记录手动核实：向发送者 ${approved.senderId} 记入 ${(approved.amountCents / 100).toFixed(2)} 元额度（回执引用 ${approved.receiptRef}）。`
      : approved.reason === 'duplicate-reference' ? '这个回执引用已使用，未新增额度。'
        : approved.reason === 'invalid-input' ? '金额须为正整数分，回执引用须为 1–160 个字符。'
          : '没有找到待核实候选，记录未更改。');
    return true;
  }

  if (friendMatch || ownerQuery) {
    if (!isOwner || isGroup) {
      await say('这项查询只允许主人私聊使用。');
      return true;
    }
    if (friendMatch) {
      try {
        const friends = await getFriendList();
        const pageSize = 30;
        const page = Math.max(1, Number(friendMatch[1] || 1));
        const pages = Math.max(1, Math.ceil(friends.length / pageSize));
        if (!friends.length) await say('当前好友列表为空。');
        else if (page > pages) await say(`好友共 ${friends.length} 位，第 ${pages} 页是最后一页。`);
        else {
          const lines = friends.slice((page - 1) * pageSize, page * pageSize)
            .map((friend, index) => `${(page - 1) * pageSize + index + 1}. ${friend.remark || friend.nickname || '（无昵称）'}（${friend.user_id}）`);
          await say(`好友列表 ${page}/${pages}（共 ${friends.length} 位）：\n${lines.join('\n')}${pages > 1 ? `\n发送“好友列表 ${Math.min(page + 1, pages)}”查看下一页。` : ''}`);
        }
      } catch (error) {
        console.error('[owner-friends] query failed:', error?.message ?? error);
        await say('好友列表查询失败，当前没有可核验结果。');
      }
      return true;
    }
    if (command === '红包账本') {
      const balances = ownerLedgerSummary();
      const lines = balances.map((entry) => `${entry.sender_id}：核验现金净额 ${(Number(entry.amount_cents) / 100).toFixed(2)} 元`);
      await say(`核验红包现金账本${lines.length ? `：\n${lines.join('\n')}` : '：目前没有可核验的红包入账记录。'}\n此处为本地现金账本净额，不含单位赠送或单位兑换，也不代表 QQ 钱包余额。${redPacketCapabilityStatus().reason}`);
    } else {
      await say(redPacketCapabilityStatus().walletBalance
        ? 'QQ 钱包余额查询已启用。' : '当前适配器没有受支持的 QQ 钱包真实余额查询接口，因此无法查询。');
    }
    return true;
  }

  return false;
}

export function resetSongLibraryCommandStateForTests() {
  libraryLoaded = false;
  reservationsReconciled = false;
  playlistSnapshots.clear();
}
