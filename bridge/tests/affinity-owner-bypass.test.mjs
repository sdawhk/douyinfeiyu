// 验证“主人专用通道”：只跳过每日配额与 20 分钟冷却，
// 步长仍 ±1、0–100 封顶、关键词/模型判定与反刷分规则全部不变。
//
// 运行：node --test tests/affinity-owner-bypass.test.mjs
// 安全：通过 AFFINITY_STATE_PATH 指向临时目录，绝不读写 D:\deepseek\state\affinity.json。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIR = await mkdtemp(path.join(tmpdir(), 'affinity-owner-bypass-'));
process.env.AFFINITY_STATE_DIR = DIR;
process.env.AFFINITY_STATE_PATH = path.join(DIR, 'affinity.json');
const { recordAffinityMessage, recordModelAffinityAssessment, adjustAffinity } = await import('../src/affinity-store.mjs');

const FILE = process.env.AFFINITY_STATE_PATH;
const OWNER = '1668389572';
const OWNERS = [OWNER, '2427256325'];
const STRANGER = '10001001';

function localDay(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayRecord(now) {
  return { date: localDay(now), positive: 0, negative: 0 };
}

async function writeState(state) {
  await writeFile(FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function readState() {
  return JSON.parse(await readFile(FILE, 'utf8'));
}

/** 造一条“配额已满 + 刚加过分”的记录，同时触发 daily 与 cooldown 两道闸门。 */
function saturated(qq, score, now, { positive = 3, negative = 0, delta = 1 } = {}) {
  return {
    [qq]: {
      score,
      daily: { ...dayRecord(now), positive, negative },
      events: [{ delta, reason: 'seed', at: new Date(now - 60_000).toISOString(), source: 'automatic' }]
    }
  };
}

after(async () => {
  delete process.env.AFFINITY_STATE_DIR;
  delete process.env.AFFINITY_STATE_PATH;
  await rm(DIR, { recursive: true, force: true }).catch(() => {});
});

test('主人同一天第 4、5 次自动正向加分仍然成功（daily=3 已满）', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 60, now));
  const fourth = recordAffinityMessage(OWNER, '谢谢爸', now, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(fourth.delta, 1, '第 4 次应 +1');
  assert.equal(fourth.score, 61);
  const fifth = recordAffinityMessage(OWNER, '爸辛苦了', now + 1_000, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(fifth.delta, 1, '第 5 次应 +1');
  assert.equal(fifth.score, 62);
  const state = await readState();
  assert.equal(state[OWNER].daily.positive, 3, 'bypass 不应继续累加每日计数');
  console.log(`[test] owner 4th=${fourth.score} 5th=${fifth.score} daily.positive=${state[OWNER].daily.positive}`);
});

test('主人在 20 分钟冷却窗口内连续加分仍然成功', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 62, now));
  const fast = recordAffinityMessage(OWNER, '帮大忙了', now + 5_000, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(fast.delta, 1, '冷却内主人仍应 +1');
  assert.equal(fast.score, 63);
  console.log(`[test] cowindow +5s → score=${fast.score}`);
});

test('只传主人 QQ 列表（不传 isOwner）也能识别主人', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 63, now));
  const viaList = recordAffinityMessage(OWNER, '真靠谱', now, { directed: true, ownerQQs: OWNERS });
  assert.equal(viaList.delta, 1);
  assert.equal(viaList.score, 64);
  console.log('[test] ownerQQs 列表单独生效');
});

test('群友第 4 次被每日配额拦住', async () => {
  const now = Date.now();
  await writeState({
    [STRANGER]: {
      score: 50,
      daily: { ...dayRecord(now), positive: 3 },
      events: [{ delta: 1, reason: 'seed', at: new Date(now - 30 * 60_000).toISOString(), source: 'automatic' }]
    }
  });
  const blocked = recordAffinityMessage(STRANGER, '谢谢你', now, { directed: true });
  assert.equal(blocked.score, 50, '第 4 次不应加分');
  assert.equal(blocked.delta, undefined, '被配额拦住时不应返回 delta');
  console.log('[test] stranger 第 4 次被 daily 拦住，score 仍为 50');
});

test('群友在冷却窗口内被拦住', async () => {
  const now = Date.now();
  await writeState(saturated(STRANGER, 50, now, { positive: 1 }));
  const blocked = recordAffinityMessage(STRANGER, '谢谢你', now, { directed: true });
  assert.equal(blocked, null, '冷却内应直接返回 null');
  console.log('[test] stranger 冷却内返回 null');
});

test('封顶仍生效：99 → 100，再加不涨', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 99, now));
  const capped = recordAffinityMessage(OWNER, '谢谢你', now, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(capped.score, 100);
  const again = recordAffinityMessage(OWNER, '太棒了', now + 1_000, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(again.score, 100, '满分后不应超过 100');
  const state = await readState();
  assert.equal(state[OWNER].score, 100);
  console.log(`[test] cap 99→${capped.score}，再加→${again.score}`);
});

test('负向路径不变：群友照旧受限，主人仍只 -1', async () => {
  const now = Date.now();
  await writeState({
    [STRANGER]: {
      score: 50,
      daily: { ...dayRecord(now), negative: 3 },
      events: [{ delta: -1, reason: 'seed', at: new Date(now - 30 * 60_000).toISOString(), source: 'automatic' }]
    }
  });
  const strangerBlocked = recordAffinityMessage(STRANGER, '你个废物', now, { directed: true });
  assert.equal(strangerBlocked.score, 50, '群友负向每日满 3 次后应被拦');

  await writeState(saturated(OWNER, 1, now, { positive: 0, negative: 3, delta: -1 }));
  const ownerPenalty = recordAffinityMessage(OWNER, '你个废物', now, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(ownerPenalty.delta, -1, '主人负向仍是 -1');
  assert.equal(ownerPenalty.score, 0);

  const atZero = recordAffinityMessage(OWNER, '傻逼', now + 1_000, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(atZero.score, 0, '0 分不能再减');
  console.log('[test] 负向：群友被拦 / 主人 -1 / 0 分不越界');
});

test('模型判断通道同样给主人 bypass，但 ±1 校验不变', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 70, now));
  const change = recordModelAffinityAssessment(OWNER, '+1', 'warmth', now, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(change.delta, 1);
  assert.equal(change.score, 71);

  await writeState(saturated(STRANGER, 50, now));
  const blocked = recordModelAffinityAssessment(STRANGER, '+1', 'warmth', now, { directed: true });
  assert.equal(blocked, null, '群友模型判断仍受冷却限制');

  const tooBig = recordModelAffinityAssessment(OWNER, '+2', 'warmth', now, { directed: true, isOwner: true, ownerQQs: OWNERS });
  assert.equal(tooBig, null, '±1 校验不能被放宽');
  console.log('[test] 模型通道：owner +1 成功，群友被拦，+2 仍非法');
});

test('反刷分规则不因 bypass 放宽', async () => {
  const now = Date.now();
  await writeState(saturated(OWNER, 70, now));
  assert.equal(recordAffinityMessage(OWNER, '/好感度 设置 1668389572 100', now, { isOwner: true, ownerQQs: OWNERS }), null,
    '斜杠命令不记分');
  assert.equal(recordAffinityMessage(OWNER, `谢谢爸。${'啊'.repeat(300)}`, now, { isOwner: true, ownerQQs: OWNERS }), null,
    '超过 300 字不记分');
  assert.equal(recordAffinityMessage(OWNER, '不是谢谢你', now, { isOwner: true, ownerQQs: OWNERS }), null,
    '否定/反讽表达不记分');
  assert.equal(recordAffinityMessage(OWNER, '谢谢你', now, { directed: false, isOwner: true, ownerQQs: OWNERS }), null,
    '非 directed 不记分');
  console.log('[test] 斜杠 / 超长 / 否定 / 未指向 均仍被拦');
});

test('主人手动命令路径不受影响（仍是 ±10）', async () => {
  const now = Date.now();
  await writeState({ [OWNER]: { score: 70, daily: dayRecord(now), events: [] } });
  const adjusted = adjustAffinity(OWNER, 10, '主人手动调整');
  assert.equal(adjusted.score, 80);
  assert.throws(() => adjustAffinity(OWNER, 11), /-10～-1/);
  console.log('[test] 手动 adjust ±10 未变');
});
