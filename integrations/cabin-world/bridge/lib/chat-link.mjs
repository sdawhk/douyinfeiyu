// 小屋 → 聊天：把「她刚才在屋里干了什么」写成一条流水，聊天那边（鱼窝 / 你自己的机器人）读它，
// 鱼就知道自己刚才真的去过哪儿、买了什么、钓到了什么，而不是只在小屋里存在过。
//
// 只写本地文件，不发网络请求。格式一行一条 JSON：
//   {"ts":1699999999999,"fish":"xiaojingyu","name":"阿雨","kind":"use","label":"泡汤","text":"泡得浑身暖烘烘的"}
//
// 想关掉：bridge.config.json 里给 "chatLink": { "enabled": false }。
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 400;

export function createChatLink(cfg) {
  const conf = cfg.chatLink || {};
  if (conf.enabled === false) return { file: null, note() {} };
  const file = path.resolve(conf.log || path.join(cfg.dataDir, 'world', 'cabin-log.jsonl'));
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 目录建不出来就算了 */ }

  // label 已经是人话（「走去公园」「泡汤」「买了汽水」），happened 第一句是游戏算出来的结果
  const note = (row, event) => {
    try {
      if (!event || event.type !== 'task' || event.status !== 'done') return;
      const result = event.result || {};
      const happened = (Array.isArray(result.happened) ? result.happened : []).filter(Boolean).map(String);
      const line = {
        ts: Date.now(),
        fish: row.key,
        name: row.name,
        kind: String(event.kind || ''),
        ...(event.source ? { source: String(event.source) } : {}),
        label: String(event.label || result.label || ''),
        text: (happened[0] || event.label || result.label || '').slice(0, 200),
        coins: result.coins ?? null,
        ...(event.source === 'autonomy' && event.kind === 'buy' ? { spent: Number(result.price) || 0 } : {}),
      };
      if (!line.label && !line.text) return;
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
      // 有界：超过 400 行裁掉前一半，别让它无限长
      const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (raw.length > MAX_LINES) fs.writeFileSync(file, raw.slice(-Math.floor(MAX_LINES / 2)).join('\n') + '\n');
    } catch { /* 写失败不影响游戏 */ }
  };
  return { file, note };
}
