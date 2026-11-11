import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueuePendingSend, flushPendingSends, loadPendingSend, pendingSendSummary, resolveImageDeliverKey } from '../src/imagegen-pending-send.mjs';

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'pending-send-'));
  const image = join(dir, 'a.jpg');
  writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return { dir, image, statePath: join(dir, 'pending-send.json') };
}

test('待发队列：入队去重、补发幂等、失败重试到上限', async () => {
  const { dir, image, statePath } = tempState();
  try {
    const first = enqueuePendingSend({ filePath: image, target: 'private:1', createdAt: 1 }, statePath);
    assert.equal(first.added, true);
    // 同一文件 + 同一目标不重复入队（重启也不会重复发）。
    const again = enqueuePendingSend({ filePath: image, target: 'private:1', createdAt: 2 }, statePath);
    assert.equal(again.added, false);
    // 同一文件换目标算另一条。
    assert.equal(enqueuePendingSend({ filePath: image, target: 'group:2', createdAt: 3 }, statePath).added, true);
    assert.equal(loadPendingSend(statePath).items.length, 2);

    const firstFlush = await flushPendingSends(async () => 'msg-1', { statePath, now: () => 10 });
    assert.equal(firstFlush.sent, 2);
    // 已发的不再重发。
    const secondFlush = await flushPendingSends(async () => 'msg-2', { statePath, now: () => 11 });
    assert.equal(secondFlush.sent, 0);
    assert.equal(pendingSendSummary(statePath).sent.length, 2);
    assert.equal(pendingSendSummary(statePath).sent[0].messageId, 'msg-1');

    // 发送一直失败：累计到上限后标记 failed，不再无限重试。
    const second = tempState();
    enqueuePendingSend({ filePath: second.image, target: 'private:9' }, second.statePath);
    let calls = 0;
    for (let i = 0; i < 3; i += 1) {
      await flushPendingSends(async () => { calls += 1; throw new Error('offline'); }, { statePath: second.statePath, maxAttempts: 3, now: () => i });
    }
    assert.equal(calls, 3);
    assert.equal(pendingSendSummary(second.statePath).failed.length, 1);
    assert.equal(pendingSendSummary(second.statePath).pending.length, 0);
    rmSync(second.dir, { recursive: true, force: true });

    // 入队时就带上真实失败原因，避免 lastError 留空。
    const third = tempState();
    enqueuePendingSend({ filePath: third.image, target: 'private:3', lastError: 'agent token 无效' }, third.statePath);
    assert.equal(loadPendingSend(third.statePath).items[0].lastError, 'agent token 无效');
    rmSync(third.dir, { recursive: true, force: true });

    // 文件丢了直接标失败，不无限挂起。
    const lost = join(dir, 'missing.jpg');
    enqueuePendingSend({ filePath: lost, target: 'private:1' }, statePath);
    const afterLost = await flushPendingSends(async () => 'x', { statePath });
    assert.equal(afterLost.failed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('投递目标解析：谁要的图回谁所在的会话', () => {
  // 私聊回私聊，不再从 config 推导 owner。
  assert.equal(resolveImageDeliverKey({ isGroup: false, sessionKey: 'private:1668389572', ownerQQ: '1668389572' }), 'private:1668389572');
  assert.equal(resolveImageDeliverKey({ isGroup: false, sessionKey: 'private:1668389572', ownerQQ: '999' }), 'private:1668389572');
  // 群里触发的图回到原来的群，不再转私聊。
  assert.equal(resolveImageDeliverKey({ isGroup: true, sessionKey: 'group:839367702', ownerQQ: '1668389572' }), 'group:839367702');
  // 会话 key 缺失时才退回主人私聊。
  assert.equal(resolveImageDeliverKey({ isGroup: false, sessionKey: '', ownerQQ: '1668389572' }), 'private:1668389572');
  assert.equal(resolveImageDeliverKey({ sessionKey: '' }), '');
});

test('待发队列：自发目标改投主人，不把发给自己当成功', async () => {
  const { dir, image, statePath } = tempState();
  const self = '2427256325';
  const owner = '1668389572';
  const logs = [];
  try {
    enqueuePendingSend({ filePath: image, target: `private:${self}`, createdAt: 1 }, statePath);
    const delivered = [];
    const summary = await flushPendingSends(async (item) => {
      delivered.push(item.target);
      return 'msg-owner';
    }, { statePath, selfId: self, ownerId: owner, log: (line) => logs.push(line), now: () => 5 });

    assert.equal(summary.retargeted, 1);
    assert.equal(summary.sent, 1);
    assert.deepEqual(delivered, [`private:${owner}`]);
    const item = loadPendingSend(statePath).items[0];
    assert.equal(item.target, `private:${owner}`);
    assert.equal(item.retarget.from, `private:${self}`);
    assert.equal(item.status, 'sent');
    assert.ok(logs.some((line) => line.includes('retarget')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待发队列：无法改投时标 failed(target-invalid)，绝不记 sent', async () => {
  const { dir, image, statePath } = tempState();
  const self = '2427256325';
  try {
    enqueuePendingSend({ filePath: image, target: `private:${self}` }, statePath);
    let called = 0;
    const summary = await flushPendingSends(async () => { called += 1; return 'msg-self'; }, {
      statePath, selfId: self, ownerId: '', now: () => 7
    });
    assert.equal(called, 0);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 1);
    const item = loadPendingSend(statePath).items[0];
    assert.equal(item.status, 'failed');
    assert.match(item.lastError, /target-invalid/);
    assert.equal(item.sentAt, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('待发队列：目录不存在时自动创建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pending-send-'));
  const statePath = join(dir, 'nested', 'deep', 'pending.json');
  const image = join(dir, 'b.jpg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(image, Buffer.from([1]));
  const result = enqueuePendingSend({ filePath: image, target: 'private:1' }, statePath);
  assert.equal(result.added, true);
  rmSync(dir, { recursive: true, force: true });
});
