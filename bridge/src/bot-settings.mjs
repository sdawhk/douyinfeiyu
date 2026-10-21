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
  const owner = config.ownerProactive || {};
  const poke = config.pokeInteraction || {};
  return {
    groupReplyCooldownMs: config.groupReplyCooldownMs ?? 20_000,
    groupInterjectionDisabled: config.groupInterjectionDisabled || [],
    dailyQzone: {
      enabled: qzone.enabled === true,
      minute: qzone.minute ?? 0,
      minIntervalMs: qzone.minIntervalMs ?? 3_600_000
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
  const o = value.ownerProactive;
  const p = value.pokeInteraction;
  if (!q || !o || !p || !Array.isArray(value.groupInterjectionDisabled)) throw Object.assign(new Error('设置内容不完整'), { status: 400 });
  const disabled = [...new Set(value.groupInterjectionDisabled.map(String))];
  if (disabled.length > 100 || disabled.some((id) => !/^\d{5,20}$/.test(id))) {
    throw Object.assign(new Error('群号列表无效'), { status: 400 });
  }
  const startHour = integer(o.startHour, 0, 23, '开始时间');
  const endHour = integer(o.endHour, 1, 24, '结束时间');
  if (endHour <= startHour) throw Object.assign(new Error('结束时间必须晚于开始时间'), { status: 400 });
  return {
    groupReplyCooldownMs: integer(value.groupReplyCooldownMs, 0, 300_000, '群聊冷却时间'),
    groupInterjectionDisabled: disabled,
    dailyQzone: {
      enabled: boolean(q.enabled, 'QQ 动态'),
      minute: integer(q.minute, 0, 59, '整点分钟'),
      minIntervalMs: integer(q.minIntervalMs, 3_600_000, 86_400_000, '动态最短间隔')
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
  config.groupReplyCooldownMs = settings.groupReplyCooldownMs;
  config.groupInterjectionDisabled = settings.groupInterjectionDisabled;
  config.dailyQzone = { ...config.dailyQzone, ...settings.dailyQzone };
  config.ownerProactive = { ...config.ownerProactive, ...settings.ownerProactive };
  config.pokeInteraction = { ...config.pokeInteraction, ...settings.pokeInteraction };
  const temp = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(`${configPath}.bak`, raw, 'utf8');
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temp, configPath);
  return readSettingsDocument(configPath);
}
