import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = fileURLToPath(new URL('../config.json', import.meta.url));

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${name}必须在 ${min}～${max} 之间`), { status: 400 });
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${name}必须选择开启或关闭`), { status: 400 });
  return value;
}

export function publicSettings(config) {
  const qzone = config.dailyQzone || {};
  const qzoneLike = config.qzoneLikeReply || {};
  const qzoneSocial = config.qzoneSocial || {};
  const ownerCardLike = config.ownerCardLike || {};
  const owner = config.ownerProactive || {};
  const poke = config.pokeInteraction || {};
  const sticker = config.stickerCooldown || {};
  const groupAffinity = config.groupAffinity || {};
  const azureTts = config.azureTts || {};
  const xfyunTts = config.xfyunTts || {};
  const edgeTts = config.edgeTts || {};
  const voiceClone = config.voiceClone || {};
  const speechRvc = config.speechRvc || {};
  const singing = config.singing || {};
  const replyControl = config.replyControl || {};
  return {
    voiceReplyProbability: Number.isInteger(config.voiceReplyProbability) && config.voiceReplyProbability >= 0 && config.voiceReplyProbability <= 100 ? config.voiceReplyProbability : 20,
    replyControl: {
      privateEnabled: replyControl.privateEnabled !== false,
      groupEnabled: replyControl.groupEnabled !== false,
      disabledPrivate: Array.isArray(replyControl.disabledPrivate) ? replyControl.disabledPrivate.map(String) : [],
      disabledGroups: Array.isArray(replyControl.disabledGroups) ? replyControl.disabledGroups.map(String) : []
    },
    azureTts: {
      enabled: azureTts.enabled === true,
      mode: ['always', 'probability'].includes(azureTts.mode) ? azureTts.mode : 'requested',
      region: azureTts.region || '',
      voice: azureTts.voice || 'zh-CN-XiaoxiaoNeural',
      rate: azureTts.rate || '0%',
      hasKey: Boolean(azureTts.key)
    },
    xfyunTts: {
      enabled: xfyunTts.enabled === true,
      mode: ['always', 'probability'].includes(xfyunTts.mode) ? xfyunTts.mode : 'requested',
      appId: xfyunTts.appId || '',
      voice: xfyunTts.voice || 'x5_lingxiaoxuan_flow',
      speed: xfyunTts.speed ?? 50,
      authMode: xfyunTts.authMode === 'signature' ? 'signature' : 'password',
      hasApiPassword: Boolean(xfyunTts.apiPassword),
      hasApiKey: Boolean(xfyunTts.apiKey),
      hasApiSecret: Boolean(xfyunTts.apiSecret)
    },
    singing: { enabled: singing.enabled === true, coverEnabled: singing.coverEnabled !== false, hasApiKey: Boolean(singing.apiKey),
      rvcEnabled: singing.rvcEnabled === true, rvcPitch: Number.isInteger(singing.rvcPitch) ? singing.rvcPitch : 0,
      allowedQQs: Array.isArray(singing.allowedQQs) ? singing.allowedQQs.map(String) : [] },
    edgeTts: { enabled: edgeTts.enabled === true, mode: ['always', 'probability'].includes(edgeTts.mode) ? edgeTts.mode : 'requested',
      url: edgeTts.workerUrl || edgeTts.url || 'https://tts.wangwangit.com', voice: edgeTts.voice || 'zh-CN-XiaoxiaoNeural' },
    voiceClone: { enabled: voiceClone.enabled === true, mode: ['always', 'probability'].includes(voiceClone.mode) ? voiceClone.mode : 'requested',
      endpoint: voiceClone.endpoint || 'http://127.0.0.1:9882', refAudio: voiceClone.refAudio || '', refText: voiceClone.refText || '' },
    speechRvc: { enabled: speechRvc.enabled === true, pitch: Number.isInteger(speechRvc.pitch) ? speechRvc.pitch : 0 },
    autoSticker: config.autoSticker !== false,
    groupMuteEnabled: config.groupMuteEnabled === true,
    groupReplyCooldownMs: config.groupReplyCooldownMs ?? 20_000,
    messageBatch: {
      enabled: config.messageBatch?.enabled !== false,
      idleMs: config.messageBatch?.idleMs ?? 5_000,
      maxMs: config.messageBatch?.maxMs ?? 15_000
    },
    groupAffinity: {
      enabled: groupAffinity.enabled !== false,
      previewOnly: groupAffinity.previewOnly !== false,
      warnAt: groupAffinity.warnAt ?? 25,
      leaveAt: groupAffinity.leaveAt ?? 10,
      dropAfterWarning: groupAffinity.dropAfterWarning ?? 5,
      protectedGroups: Array.isArray(groupAffinity.protectedGroups) ? [...new Set(groupAffinity.protectedGroups.map(String))] : []
    },
    groupInterjectionDisabled: config.groupInterjectionDisabled || [],
    stickerCooldown: {
      privateMs: sticker.privateMs ?? 300_000,
      groupMs: sticker.groupMs ?? 300_000,
      privateRequestMs: sticker.privateRequestMs ?? 10_000,
      groupRequestMs: sticker.groupRequestMs ?? 30_000
    },
    dailyQzone: {
      enabled: qzone.enabled === true,
      minute: qzone.minute ?? 0,
      minIntervalMs: qzone.minIntervalMs ?? 3_600_000
    },
    qzoneLikeReply: {
      enabled: qzoneLike.enabled === true,
      cooldownMs: qzoneLike.cooldownMs ?? 21_600_000,
      maxPerDay: qzoneLike.maxPerDay ?? 3
    },
    ownerCardLike: {
      enabled: ownerCardLike.enabled !== false,
      time: /^\d{2}:\d{2}$/.test(ownerCardLike.time || '') ? ownerCardLike.time : '10:00'
    },
    qzoneSocial: {
      enabled: qzoneSocial.enabled === true,
      previewOnly: qzoneSocial.previewOnly !== false,
      allowedFriends: Array.isArray(qzoneSocial.allowedFriends) ? [...new Set(qzoneSocial.allowedFriends.map(String))] : [],
      likeThreshold: qzoneSocial.likeThreshold ?? 75,
      commentThreshold: qzoneSocial.commentThreshold ?? 85,
      replyOwnComments: qzoneSocial.replyOwnComments === true,
      checkIntervalMs: qzoneSocial.checkIntervalMs ?? 900_000,
      maxLikesPerDay: qzoneSocial.maxLikesPerDay ?? 3,
      maxCommentsPerDay: qzoneSocial.maxCommentsPerDay ?? 1,
      maxRepliesPerDay: qzoneSocial.maxRepliesPerDay ?? 3,
      friendCooldownMs: qzoneSocial.friendCooldownMs ?? 86_400_000
    },
    ownerProactive: {
      enabled: owner.enabled !== false,
      idleMs: owner.idleMs ?? 7_200_000,
      checkIntervalMs: owner.checkIntervalMs ?? 900_000,
      cooldownMs: owner.cooldownMs ?? 14_400_000,
      maxPerDay: owner.maxPerDay ?? 3,
      startHour: owner.startHour ?? 9,
      endHour: owner.endHour ?? 22
    },
    pokeInteraction: {
      enabled: poke.enabled !== false,
      replyInGroup: poke.replyInGroup !== false,
      replyInPrivate: poke.replyInPrivate !== false,
      replyToOthers: poke.replyToOthers === true,
      pokeBack: poke.pokeBack !== false,
      cooldownMs: poke.cooldownMs ?? 120_000,
      maxPerHour: poke.maxPerHour ?? 6,
      replies: poke.replies ?? '戳到我啦？\n在呢，怎么啦？\n再戳就要反击啦。',
      othersReplies: poke.othersReplies ?? '你们戳来戳去的，好热闹。'
    }
  };
}

function pokeReplies(value, name) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${name}必须填写文字`), { status: 400 });
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 12 || lines.some((line) => line.length > 100)) {
    throw Object.assign(new Error(`${name}需填写 1～12 行，每行不超过 100 字`), { status: 400 });
  }
  return lines.join('\n');
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('设置格式无效'), { status: 400 });
  const q = value.dailyQzone;
  const ql = value.qzoneLikeReply;
  const ownerCardLike = value.ownerCardLike;
  const qs = value.qzoneSocial;
  const o = value.ownerProactive;
  const p = value.pokeInteraction;
  const sticker = value.stickerCooldown;
  const batch = value.messageBatch;
  const groupAffinity = value.groupAffinity;
  const azureTts = value.azureTts || {};
  const xfyunTts = value.xfyunTts || {};
  const singing = value.singing || {};
  const edgeTts = value.edgeTts || {};
  const voiceClone = value.voiceClone || {};
  const speechRvc = value.speechRvc || {};
  const replyControl = value.replyControl;
  if (!replyControl || typeof replyControl !== 'object') throw Object.assign(new Error('聊天回复开关缺失'), { status: 400 });
  const replyIds = (ids, name) => {
    if (!Array.isArray(ids)) throw Object.assign(new Error(`${name}列表无效`), { status: 400 });
    const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (unique.length > 100 || unique.some((id) => !/^\d{5,20}$/.test(id))) throw Object.assign(new Error(`${name}列表无效`), { status: 400 });
    return unique;
  };
  if (!q || !ql || !ownerCardLike || !qs || !o || !p || !sticker || !batch || !groupAffinity || !Array.isArray(value.groupInterjectionDisabled)) throw Object.assign(new Error('设置内容不完整'), { status: 400 });
  const azureKey = typeof azureTts.key === 'string' ? azureTts.key.trim() : '';
  if (azureTts.clearKey === true && azureKey) throw Object.assign(new Error('清除 Key 与填写新 Key 不能同时进行'), { status: 400 });
  if (azureKey.length > 512) throw Object.assign(new Error('Azure Speech Key 长度无效'), { status: 400 });
  if (typeof azureTts.region !== 'string' || azureTts.region.length > 80 || /[^a-z0-9-]/i.test(azureTts.region)) throw Object.assign(new Error('Azure Speech 区域格式无效'), { status: 400 });
  if (typeof azureTts.voice !== 'string' || !/^[a-z0-9:-]{3,100}$/i.test(azureTts.voice)) throw Object.assign(new Error('Azure 中文音色格式无效'), { status: 400 });
  if (!['-15%', '0%', '+15%'].includes(azureTts.rate || '0%')) throw Object.assign(new Error('语速选项无效'), { status: 400 });
  if (azureTts.mode !== undefined && !['requested', 'always', 'probability'].includes(azureTts.mode)) throw Object.assign(new Error('语音触发方式无效'), { status: 400 });
  const xfyunPassword = typeof xfyunTts.apiPassword === 'string' ? xfyunTts.apiPassword.trim() : '';
  const xfyunKey = typeof xfyunTts.apiKey === 'string' ? xfyunTts.apiKey.trim() : '';
  const xfyunSecret = typeof xfyunTts.apiSecret === 'string' ? xfyunTts.apiSecret.trim() : '';
  if (typeof xfyunTts.appId !== 'string' || !/^[a-z0-9]{0,50}$/i.test(xfyunTts.appId)) throw Object.assign(new Error('讯飞 APPID 格式无效'), { status: 400 });
  if (typeof xfyunTts.voice !== 'string' || !/^[a-z0-9_]{3,100}$/i.test(xfyunTts.voice)) throw Object.assign(new Error('讯飞发音人 ID 格式无效'), { status: 400 });
  if (!['password', 'signature'].includes(xfyunTts.authMode)) throw Object.assign(new Error('讯飞鉴权方式无效'), { status: 400 });
  if (!['requested', 'always', 'probability'].includes(xfyunTts.mode)) throw Object.assign(new Error('讯飞语音触发方式无效'), { status: 400 });
  for (const [secret, label] of [[xfyunPassword, 'APIPassword'], [xfyunKey, 'APIKey'], [xfyunSecret, 'APISecret']]) {
    if (secret.length > 512) throw Object.assign(new Error(`讯飞 ${label} 长度无效`), { status: 400 });
  }
  for (const [clear, secret] of [[xfyunTts.clearApiPassword, xfyunPassword], [xfyunTts.clearApiKey, xfyunKey], [xfyunTts.clearApiSecret, xfyunSecret]]) {
    if (clear === true && secret) throw Object.assign(new Error('不能同时清除和填写同一个讯飞密钥'), { status: 400 });
  }
  const singingKey = typeof singing.apiKey === 'string' ? singing.apiKey.trim() : '';
  if (singingKey.length > 512 || (singing.clearApiKey === true && singingKey)) throw Object.assign(new Error('音乐 API Key 格式无效'), { status: 400 });
  const singingPitch = integer(singing.rvcPitch ?? 0, -12, 12, '流萤变调');
  const singingAllowedQQs = replyIds(singing.allowedQQs ?? [], '新歌点唱 QQ 白名单');
  if (!['requested', 'always', 'probability'].includes(edgeTts.mode)) throw Object.assign(new Error('Edge TTS 触发方式无效'), { status: 400 });
  if (typeof edgeTts.voice !== 'string' || !/^zh-CN-[A-Za-z]+Neural$/.test(edgeTts.voice)) throw Object.assign(new Error('Edge TTS 中文音色无效'), { status: 400 });
  if (typeof edgeTts.url !== 'string' || edgeTts.url.length > 250) throw Object.assign(new Error('Edge TTS 地址无效'), { status: 400 });
  try { const url = new URL(edgeTts.url); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error(); }
  catch { throw Object.assign(new Error('Edge TTS 地址须为 HTTPS 或本机 HTTP'), { status: 400 }); }
  if (!['requested', 'always', 'probability'].includes(voiceClone.mode)) throw Object.assign(new Error('克隆音色回复方式无效'), { status: 400 });
  if (typeof voiceClone.endpoint !== 'string' || voiceClone.endpoint.length > 250) throw Object.assign(new Error('克隆音色服务地址无效'), { status: 400 });
  try {
    const url = new URL(voiceClone.endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/', '/tts'].includes(url.pathname)) throw new Error();
  } catch { throw Object.assign(new Error('克隆音色服务只接受本机 HTTP 地址'), { status: 400 }); }
  if (typeof voiceClone.refAudio !== 'string' || voiceClone.refAudio.length > 500
    || (voiceClone.refAudio && !/^(?:[a-z]:\\|\\\\)/i.test(voiceClone.refAudio))) throw Object.assign(new Error('参考音频须填写 Windows 绝对路径'), { status: 400 });
  if (typeof voiceClone.refText !== 'string' || voiceClone.refText.length > 500) throw Object.assign(new Error('参考音频原文过长'), { status: 400 });
  if (voiceClone.enabled && (!voiceClone.refAudio.trim() || !voiceClone.refText.trim())) {
    throw Object.assign(new Error('启用克隆音色前，请填写参考音频路径和逐字原文'), { status: 400 });
  }
  const speechRvcPitch = integer(speechRvc.pitch ?? 0, -12, 12, '普通语音流萤变调');
  const disabled = [...new Set(value.groupInterjectionDisabled.map(String))];
  if (disabled.length > 100 || disabled.some((id) => !/^\d{5,20}$/.test(id))) {
    throw Object.assign(new Error('群号列表无效'), { status: 400 });
  }
  const startHour = integer(o.startHour, 0, 23, '开始时间');
  const endHour = integer(o.endHour, 1, 24, '结束时间');
  if (endHour <= startHour) throw Object.assign(new Error('结束时间必须晚于开始时间'), { status: 400 });
  const allowedFriends = [...new Set((Array.isArray(qs.allowedFriends) ? qs.allowedFriends : []).map((id) => String(id).trim()).filter(Boolean))];
  if (allowedFriends.length > 100 || allowedFriends.some((id) => !/^\d{5,20}$/.test(id))) throw Object.assign(new Error('动态互动好友白名单无效（每行填写 QQ 号，最多 100 个）'), { status: 400 });
  const likeThreshold = integer(qs.likeThreshold, 0, 100, '点赞好感度门槛');
  const commentThreshold = integer(qs.commentThreshold, 0, 100, '评论好感度门槛');
  if (commentThreshold < likeThreshold) throw Object.assign(new Error('评论门槛不能低于点赞门槛'), { status: 400 });
  if (typeof ownerCardLike.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(ownerCardLike.time)) throw Object.assign(new Error('给主人名片点赞的时间格式无效'), { status: 400 });
  if (batch.maxMs < batch.idleMs) throw Object.assign(new Error('最长等待不能短于连续消息等待时间'), { status: 400 });
  const protectedGroups = [...new Set((Array.isArray(groupAffinity.protectedGroups) ? groupAffinity.protectedGroups : []).map(String))];
  if (protectedGroups.length > 100 || protectedGroups.some((id) => !/^\d{5,20}$/.test(id))) throw Object.assign(new Error('群好感度保护名单无效'), { status: 400 });
  const warnAt = integer(groupAffinity.warnAt, 1, 49, '群好感度警告分数');
  const leaveAt = integer(groupAffinity.leaveAt, 0, 48, '群好感度退群分数');
  if (leaveAt >= warnAt) throw Object.assign(new Error('退群分数必须低于警告分数'), { status: 400 });
  return {
    voiceReplyProbability: integer(value.voiceReplyProbability ?? 20, 0, 100, '普通语音回复概率'),
    replyControl: {
      privateEnabled: boolean(replyControl.privateEnabled, '私聊回复'),
      groupEnabled: boolean(replyControl.groupEnabled, '群聊回复'),
      disabledPrivate: replyIds(replyControl.disabledPrivate, '不回复的私聊 QQ 号'),
      disabledGroups: replyIds(replyControl.disabledGroups, '不回复的群号')
    },
    azureTts: {
      enabled: boolean(azureTts.enabled ?? false, 'Azure 语音回复'),
      mode: azureTts.mode,
      region: azureTts.region.trim(),
      voice: azureTts.voice,
      rate: azureTts.rate || '0%',
      ...(azureKey ? { key: azureKey } : {}),
      clearKey: azureTts.clearKey === true
    },
    xfyunTts: {
      enabled: boolean(xfyunTts.enabled ?? false, '讯飞语音回复'),
      mode: xfyunTts.mode,
      appId: xfyunTts.appId.trim(),
      voice: xfyunTts.voice,
      speed: integer(xfyunTts.speed, 0, 100, '讯飞语速'),
      authMode: xfyunTts.authMode,
      ...(xfyunPassword ? { apiPassword: xfyunPassword } : {}),
      ...(xfyunKey ? { apiKey: xfyunKey } : {}),
      ...(xfyunSecret ? { apiSecret: xfyunSecret } : {}),
      clearApiPassword: xfyunTts.clearApiPassword === true,
      clearApiKey: xfyunTts.clearApiKey === true,
      clearApiSecret: xfyunTts.clearApiSecret === true
    },
    singing: { enabled: boolean(singing.enabled ?? false, '原创唱歌功能'), coverEnabled: boolean(singing.coverEnabled ?? true, '现成歌曲点唱'), rvcEnabled: boolean(singing.rvcEnabled ?? false, '流萤音色转换'), rvcPitch: singingPitch,
      allowedQQs: singingAllowedQQs,
      ...(singingKey ? { apiKey: singingKey } : {}), clearApiKey: singing.clearApiKey === true },
    edgeTts: { enabled: boolean(edgeTts.enabled ?? false, 'Edge TTS'), mode: edgeTts.mode, url: edgeTts.url.trim(), voice: edgeTts.voice },
    voiceClone: { enabled: boolean(voiceClone.enabled ?? false, '克隆音色'), mode: voiceClone.mode,
      endpoint: voiceClone.endpoint.trim(), refAudio: voiceClone.refAudio.trim(), refText: voiceClone.refText.trim() },
    speechRvc: { enabled: boolean(speechRvc.enabled ?? false, '普通语音流萤转换'), pitch: speechRvcPitch },
    autoSticker: value.autoSticker === undefined ? undefined : boolean(value.autoSticker, '自动收录表情'),
    groupMuteEnabled: value.groupMuteEnabled === undefined ? false : boolean(value.groupMuteEnabled, '群友闭嘴开关'),
    groupReplyCooldownMs: integer(value.groupReplyCooldownMs, 0, 300_000, '群聊冷却时间'),
    messageBatch: {
      enabled: boolean(batch.enabled, '连续消息合并'),
      idleMs: integer(batch.idleMs, 1_000, 15_000, '连续消息等待时间'),
      maxMs: integer(batch.maxMs, 5_000, 30_000, '连续消息最长等待')
    },
    groupAffinity: {
      enabled: boolean(groupAffinity.enabled, '群好感度退群功能'),
      previewOnly: boolean(groupAffinity.previewOnly, '群退群预览模式'),
      warnAt,
      leaveAt,
      dropAfterWarning: integer(groupAffinity.dropAfterWarning, 1, 25, '警告后下降分数'),
      protectedGroups
    },
    groupInterjectionDisabled: disabled,
    stickerCooldown: {
      privateMs: integer(sticker.privateMs, 0, 3_600_000, '普通私聊表情冷却'),
      groupMs: integer(sticker.groupMs, 0, 3_600_000, '普通群聊表情冷却'),
      privateRequestMs: integer(sticker.privateRequestMs, 0, 300_000, '私聊索要表情冷却'),
      groupRequestMs: integer(sticker.groupRequestMs, 0, 300_000, '群聊索要表情冷却')
    },
    dailyQzone: {
      enabled: boolean(q.enabled, 'QQ 动态'),
      minute: integer(q.minute, 0, 59, '整点分钟'),
      minIntervalMs: integer(q.minIntervalMs, 3_600_000, 86_400_000, '动态最短间隔')
    },
    qzoneLikeReply: {
      enabled: boolean(ql.enabled, '动态点赞回谢'),
      cooldownMs: integer(ql.cooldownMs, 3_600_000, 604_800_000, '点赞回谢冷却时间'),
      maxPerDay: integer(ql.maxPerDay, 1, 20, '点赞回谢每日上限')
    },
    ownerCardLike: {
      enabled: boolean(ownerCardLike.enabled, '每日给主人名片点赞'),
      time: ownerCardLike.time
    },
    qzoneSocial: {
      enabled: boolean(qs.enabled, '好友动态互动'),
      previewOnly: boolean(qs.previewOnly, '动态互动预览模式'),
      allowedFriends,
      likeThreshold,
      commentThreshold,
      replyOwnComments: boolean(qs.replyOwnComments, '回复自己动态评论'),
      checkIntervalMs: integer(qs.checkIntervalMs, 300_000, 86_400_000, '动态扫描间隔'),
      maxLikesPerDay: integer(qs.maxLikesPerDay, 0, 30, '每天点赞上限'),
      maxCommentsPerDay: integer(qs.maxCommentsPerDay, 0, 10, '每天评论上限'),
      maxRepliesPerDay: integer(qs.maxRepliesPerDay, 0, 30, '每天回复上限'),
      friendCooldownMs: integer(qs.friendCooldownMs, 3_600_000, 30 * 86_400_000, '好友互动冷却')
    },
    ownerProactive: {
      enabled: boolean(o.enabled, '主动私聊'),
      idleMs: integer(o.idleMs, 1_800_000, 604_800_000, '主人空闲时间'),
      checkIntervalMs: integer(o.checkIntervalMs, 300_000, 86_400_000, '私聊检查间隔'),
      cooldownMs: integer(o.cooldownMs, 3_600_000, 604_800_000, '私聊冷却时间'),
      maxPerDay: integer(o.maxPerDay, 1, 20, '每日上限'),
      startHour,
      endHour
    },
    pokeInteraction: {
      enabled: boolean(p.enabled, '戳一戳互动'),
      replyInGroup: boolean(p.replyInGroup, '群聊戳一戳'),
      replyInPrivate: boolean(p.replyInPrivate, '私聊戳一戳'),
      replyToOthers: boolean(p.replyToOthers, '群友互戳'),
      pokeBack: boolean(p.pokeBack, '自动回戳'),
      cooldownMs: integer(p.cooldownMs, 0, 3_600_000, '戳一戳冷却时间'),
      maxPerHour: integer(p.maxPerHour, 1, 30, '戳一戳每小时上限'),
      replies: pokeReplies(p.replies, '被戳回复'),
      othersReplies: pokeReplies(p.othersReplies, '群友互戳回复')
    }
  };
}

export function readSettingsDocument(configPath = CONFIG_PATH) {
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  return {
    version: createHash('sha256').update(raw).digest('hex'),
    settings: publicSettings(config),
    groups: (config.allow?.groups || []).map(String)
  };
}

export function saveSettingsDocument(expectedVersion, value, configPath = CONFIG_PATH) {
  const settings = validateSettings(value);
  const raw = readFileSync(configPath, 'utf8');
  const version = createHash('sha256').update(raw).digest('hex');
  if (expectedVersion !== version) throw Object.assign(new Error('设置已被其他操作修改，请刷新后再保存'), { status: 409 });
  const config = JSON.parse(raw);
  const previousAzureKey = config.azureTts?.key;
  config.azureTts = { ...config.azureTts, ...settings.azureTts };
  if (settings.azureTts.clearKey) delete config.azureTts.key;
  else if (!settings.azureTts.key && previousAzureKey) config.azureTts.key = previousAzureKey;
  delete config.azureTts.clearKey;
  const previousXfyun = config.xfyunTts || {};
  config.xfyunTts = { ...previousXfyun, ...settings.xfyunTts };
  for (const [name, clear] of [['apiPassword', 'clearApiPassword'], ['apiKey', 'clearApiKey'], ['apiSecret', 'clearApiSecret']]) {
    if (settings.xfyunTts[clear]) delete config.xfyunTts[name];
    else if (!settings.xfyunTts[name] && previousXfyun[name]) config.xfyunTts[name] = previousXfyun[name];
    delete config.xfyunTts[clear];
  }
  if (config.xfyunTts.enabled && (!config.xfyunTts.appId || (config.xfyunTts.authMode === 'signature'
    ? !(config.xfyunTts.apiKey && config.xfyunTts.apiSecret) : !config.xfyunTts.apiPassword))) {
    throw Object.assign(new Error('启用讯飞语音前，请填写 APPID 和所选鉴权方式的完整凭据'), { status: 400 });
  }
  const previousSingingKey = config.singing?.apiKey;
  config.singing = { ...config.singing, ...settings.singing };
  if (settings.singing.clearApiKey) delete config.singing.apiKey;
  else if (!settings.singing.apiKey && previousSingingKey) config.singing.apiKey = previousSingingKey;
  delete config.singing.clearApiKey;
  if (config.singing.enabled && !config.singing.apiKey) throw Object.assign(new Error('启用唱歌前，请填写 Mureka 音乐 API Key'), { status: 400 });
  config.edgeTts = { ...config.edgeTts, ...settings.edgeTts,
    workerUrl: settings.edgeTts.url, url: 'http://127.0.0.1:18902' };
  config.voiceClone = { ...config.voiceClone, ...settings.voiceClone };
  config.speechRvc = { ...config.speechRvc, ...settings.speechRvc };
  config.voiceReplyProbability = settings.voiceReplyProbability;
  if (settings.autoSticker !== undefined) config.autoSticker = settings.autoSticker;
  config.replyControl = settings.replyControl;
  config.groupMuteEnabled = settings.groupMuteEnabled;
  config.groupReplyCooldownMs = settings.groupReplyCooldownMs;
  config.messageBatch = { ...config.messageBatch, ...settings.messageBatch };
  config.groupAffinity = { ...config.groupAffinity, ...settings.groupAffinity };
  config.groupInterjectionDisabled = settings.groupInterjectionDisabled;
  config.stickerCooldown = { ...config.stickerCooldown, ...settings.stickerCooldown };
  config.dailyQzone = { ...config.dailyQzone, ...settings.dailyQzone };
  config.qzoneLikeReply = { ...config.qzoneLikeReply, ...settings.qzoneLikeReply };
  config.ownerCardLike = { ...config.ownerCardLike, ...settings.ownerCardLike };
  config.qzoneSocial = { ...config.qzoneSocial, ...settings.qzoneSocial };
  config.ownerProactive = { ...config.ownerProactive, ...settings.ownerProactive };
  config.pokeInteraction = { ...config.pokeInteraction, ...settings.pokeInteraction };
  const temp = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(`${configPath}.bak`, raw, 'utf8');
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temp, configPath);
  return readSettingsDocument(configPath);
}
