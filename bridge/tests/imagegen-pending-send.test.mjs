import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueuePendingSend, flushPendingSends, loadPendingSend, pendingSendSummary } from '../src/imagegen-pending-send.mjs';

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

    // 文件丢了直接标失败，不无限挂起。
    const lost = join(dir, 'missing.jpg');
    enqueuePendingSend({ filePath: lost, target: 'private:1' }, statePath);
    const afterLost = await flushPendingSends(async () => 'x', { statePath });
    assert.equal(afterLost.failed, 1);
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
