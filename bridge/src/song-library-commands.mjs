import {
  getFreeQuota, getVerifiedCreditBalance, getVerifiedSongPreview, listSongs,
  listPendingRedPacketCandidates, listUncertainPreviews, ownerLedgerSummary, redPacketCapabilityStatus,
  approveRedPacketCandidate, rejectRedPacketCandidate,
  claimRedPacketCandidateNotification, hasRedPacketMarker, recordRedPacketCandidate, settleRedPacketCandidateNotification,
  reconcilePreviewReservations, refreshSongLibrary, reserveFreePreview,
  resolveUncertainPreview, settleFreePreview, reservePaidSongOrder,
  updatePaidSongOrder, registerSongOutput, listUncertainPaidSongOrders, resolvePaidSongOrder,
  savePaidSongSegments, listPaidSongSegments, getPaidSongOrder, updatePaidSongSegment
} from './song-library.mjs';

let libraryLoaded = false;
let reservationsReconciled = false;

export function normalizeSongCommandText(text, { selfNickname = '', selfQQ = '', hasBotMention = false } = {}) {
  const value = String(text ?? '').trim();
  const mention = value.match(/^@([^\s@]+)\s*/);
  if (!mention) return value;
  const name = mention[1].toLocaleLowerCase();
  const recognized = hasBotMention || name === String(selfNickname).toLocaleLowerCase()
    || name === String(selfQQ) || name === `qq${selfQQ}`;
  return recognized ? value.slice(mention[0].length).trim() : value;
}

export function isSongLibraryCommand(text) {
  const command = String(text ?? '').trim();
  return /^(?:歌单(?:\s+\d{1,4})?|试听\s+[a-f0-9]{12}|新歌试听(?:\s+.+)?|唱完整首(?:\s+.+)?|好友列表(?:\s+\d{1,3})?|红包账本|红包待核验|红包通过\s+[a-f0-9]{64}\s+\d+\s+\S+|红包拒绝\s+[a-f0-9]{64}|余额|QQ\s*钱包余额|试听待核对|核对试听\s+[a-f0-9]{64}\s+(?:已发送|未发送)|付费订单待核对|核对付费\s+[a-f0-9]{64}(?:\s+\d+)?\s+(?:已发送|未发送)|我的点歌额度)$/i.test(command);
}

export function shouldRouteSongLibraryCommand(text, { replyEnabled = true, muted = false } = {}) {
  return isSongLibraryCommand(text) && replyEnabled === true && muted !== true;
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
  return error?.uncertain === true || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || /timeout|timed out|aborted|econnreset|econnrefused|epipe|fetch failed|socket hang up/i.test(String(error?.message ?? error));
}

export async function handleSongLibraryCommand({
  text, key, senderId, isGroup, isOwner = false, botId = '',
  sendText, sendRecord, getFriendList, refreshLibrary = refreshSongLibrary,
  makePaidPreview, makePaidFullSong, coverEnabled = false
}) {
  const command = String(text ?? '').trim();
  const listMatch = command.match(/^歌单(?:\s+(\d{1,4}))?$/);
  const previewMatch = command.match(/^试听\s+([a-f0-9]{12})$/i);
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
          const lines = result.songs.map((song, index) => `${result.offset + index + 1}. ${song.title}（ID ${song.song_id}）`);
          await say(`本地歌单 ${page}/${pages}（共 ${result.total} 首）\n${lines.join('\n')}\n试听：试听 后面的 12 位 ID`);
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
      const songId = previewMatch[1].toLowerCase();
      const song = getVerifiedSongPreview(songId);
      if (!song) { await say('这个编号没有可用的 30 秒试听文件，请刷新歌单后重试。'); return true; }
      const reservation = reserveFreePreview({ chatKey: key, senderId, songId, now: Date.now() });
      if (!reservation.ok) {
        const message = reservation.reason === 'conversation-busy' ? '这个会话正在处理前一首试听，本轮只执行第一位点歌人的请求。'
          : reservation.reason === 'daily-limit' ? '机器人今天的免费试听次数已用完。'
            : reservation.reason === 'rolling-limit' ? '试听有点密，10 分钟内最多 3 次，稍后再试。'
              : '这首歌已不在可试听歌单里。';
        await say(message);
        return true;
      }
      try {
        await sendRecord(song.audio);
        settleFreePreview(reservation.requestId, 'sent');
        const quota = getFreeQuota();
        await say(`《${song.title}》试听已发送。免费额度：今日 ${quota.dailyUsed}/${quota.dailyLimit}，近 10 分钟 ${quota.rollingUsed}/${quota.rollingLimit}。`);
      } catch (error) {
        const uncertain = uncertainDelivery(error);
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
    await say(`可用点歌额度：${(getVerifiedCreditBalance(senderId) / 100).toFixed(2)} 元（已扣除进行中订单预留）。${redPacketCapabilityStatus().reason}`);
    return true;
  }
  if (paidMatch) {
    const fullMatch = paidFullMatch;
    const query = String(paidPreviewMatch?.[1] ?? fullMatch?.[1] ?? '').trim().slice(0, 80);
    if (!query) { await say('请提供准确歌名，例如：新歌试听 <歌名>。'); return true; }
    if (!coverEnabled || (fullMatch ? typeof makePaidFullSong !== 'function' : typeof makePaidPreview !== 'function')) {
      await say('付费点歌当前未启用；需要开启现成歌曲翻唱。');
      return true;
    }
    const kind = fullMatch ? 'full' : 'preview';
    const order = reservePaidSongOrder({ senderId, chatKey: key, query, kind });
    if (!order.ok) {
      await say(order.reason === 'conversation-busy' ? '这个会话已有点歌订单正在处理或待核对。'
        : order.reason === 'insufficient-credit' ? `可用点歌额度不足。当前可用 ${(getVerifiedCreditBalance(senderId) / 100).toFixed(2)} 元，${fullMatch ? '整首翻唱需 3.00 元' : '新歌试听需 1.00 元'}。`
          : '这条点歌请求无效，请检查歌名后重试。');
      return true;
    }
    updatePaidSongOrder(order.orderId, { status: 'processing' });
    try { await say(`已为《${query}》预留 ${(order.priceCents / 100).toFixed(2)} 元额度，正在${fullMatch ? '下载并制作整首流萤翻唱' : '制作 30 秒流萤翻唱试听'}。订单 ${order.orderId.slice(0, 12)}。`); }
    catch (error) { console.error(`[paid-song] reservation notice failed order=${order.orderId}:`, error?.message ?? error); }
    void (async () => {
      let deliveryAttempted = false;
      let currentSegment = null;
      try {
        if (kind === 'preview') {
          const result = await makePaidPreview(query, order.orderId);
          if (!result || !Buffer.isBuffer(result.audio) || !result.title || !result.sourceIdentity) throw new Error('paid preview producer returned incomplete audio');
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
          let indexed = false;
          try { indexed = result.file ? registerSongOutput({ file: result.file, title: result.title, query,
            mode: 'ai', voiceVariant: result.voiceVariant ?? '', startSeconds: result.startSeconds ?? 30, seconds: 30 }) : false; }
          catch (error) { console.error(`[paid-song] catalog registration failed order=${order.orderId}:`, error?.message ?? error); }
          try { await say(`《${result.title}》付费试听已由 OneBot 确认发送，已扣 1.00 元。${indexed ? '已加入本地歌单。' : '音频已缓存，歌单核验未通过，暂不展示。'}`); }
          catch (error) { console.error(`[paid-song] completion notice failed order=${order.orderId}:`, error?.message ?? error); }
          return;
        }
        const savedOrder = order.resume ? getPaidSongOrder(order.orderId) : null;
        const resume = savedOrder ? { sourceIdentity: savedOrder.source_identity, title: savedOrder.title, voiceVariant: savedOrder.voice_variant,
          segments: listPaidSongSegments(order.orderId) } : null;
        const result = await makePaidFullSong(query, order.orderId, { resume });
        if (!result || !Array.isArray(result.segments) || !result.segments.length || !result.title || !result.sourceIdentity) throw new Error('paid full-song producer returned incomplete segments');
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
        let indexed = false;
        try { indexed = registerSongOutput({ file: durableSegments[0].cachePath, title: result.title, query,
          mode: 'ai', voiceVariant: result.voiceVariant ?? '', startSeconds: 0, seconds: 30 }); }
        catch (error) { console.error(`[paid-song] full catalog registration failed order=${order.orderId}:`, error?.message ?? error); }
        try { await say(`《${result.title}》整首翻唱已由 OneBot 确认发送 ${segmentCount} 段，已扣 3.00 元。${indexed ? '已加入本地歌单。' : '歌单核验未通过，暂不展示。'}`); }
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
        console.error(`[paid-song] preview ${uncertain ? 'uncertain' : 'failed'} order=${order.orderId}:`, error?.message ?? error);
        await say(uncertain ? `《${query}》的发送结果无法确认；订单已冻结，不会自动重发或再次扣款。订单 ${order.orderId} 请主人核对。`
          : kind === 'full' && listPaidSongSegments(order.orderId).some((item) => item.status === 'sent')
            ? `《${query}》整首分段发送中断，已保留已确认段进度和 3.00 元预留。重新发送“唱完整首 ${query}”可从未确认段继续。订单 ${order.orderId.slice(0, 12)}。`
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
      const lines = balances.map((entry) => `${entry.sender_id}：${(Number(entry.amount_cents) / 100).toFixed(2)} 元`);
      await say(`核验红包额度账本${lines.length ? `：\n${lines.join('\n')}` : '：目前没有可核验的红包入账记录。'}\n${redPacketCapabilityStatus().reason}`);
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
}
