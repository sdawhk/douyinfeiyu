import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDrawToolQuota, decideDrawToolAccess, normalizeDrawToolArgs, DRAW_SIZE_OPTIONS
} from '../src/image-draw-tool.mjs';

test('工具参数校验', () => {
  assert.equal(normalizeDrawToolArgs({ prompt: '' }).ok, false);
  assert.match(normalizeDrawToolArgs({ prompt: '   ' }).reply, /空的/);
  assert.equal(normalizeDrawToolArgs({ prompt: 'x'.repeat(201) }).ok, false);
  assert.equal(normalizeDrawToolArgs({ prompt: '一只鲸鱼', size: '999x999' }).ok, false);
  assert.equal(normalizeDrawToolArgs({ prompt: '一只鲸鱼', size: DRAW_SIZE_OPTIONS[1] }).ok, true);
  assert.equal(normalizeDrawToolArgs({ prompt: '一只鲸鱼', style: 's'.repeat(121) }).ok, false);
  assert.equal(normalizeDrawToolArgs({ prompt: '一只鲸鱼', chatKey: 'bad-key' }).ok, false);

  const ok = normalizeDrawToolArgs({ prompt: '  一只戴墨镜的橘猫  ', size: '1344x768', style: ' warm light ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.prompt, '一只戴墨镜的橘猫');
  assert.equal(ok.request.size, '1344x768');
  assert.equal(ok.request.style, 'warm light');
});

test('工具鉴权：主人放行，非主人与群友拒绝', () => {
  const owners = ['1668389572', '2427256325'];
  const now = Date.UTC(2026, 0, 1, 4);

  assert.equal(decideDrawToolAccess({ key: 'private:1668389572', owners }).allowed, true);
  assert.equal(decideDrawToolAccess({ key: 'private:2427256325', owners }).allowed, true);

  const stranger = decideDrawToolAccess({ key: 'private:10000', owners });
  assert.equal(stranger.allowed, false);
  assert.match(stranger.reply, /只对主人开放/);
  assert.equal(decideDrawToolAccess({ key: 'bad:1', owners }).allowed, false);

  const ownerGroup = decideDrawToolAccess({
    key: 'group:839367702', owners, now,
    recentMessages: [{ isSelf: false, isOwner: true, userId: '1668389572', time: now - 30_000 }]
  });
  assert.equal(ownerGroup.allowed, true);

  const memberGroup = decideDrawToolAccess({
    key: 'group:839367702', owners, now,
    recentMessages: [{ isSelf: false, isOwner: false, userId: '10000', time: now - 30_000 }]
  });
  assert.equal(memberGroup.allowed, false);
  assert.match(memberGroup.reply, /只有主人本人/);

  const staleOwner = decideDrawToolAccess({
    key: 'group:839367702', owners, now,
    recentMessages: [{ isSelf: false, isOwner: true, userId: '1668389572', time: now - 60 * 60_000 }]
  });
  assert.equal(staleOwner.allowed, false);
});

test('工具限流：冷却、每日上限、跨天重置、落盘持久', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drawtool-'));
  const filePath = join(dir, 'tool-quota.json');
  let now = Date.UTC(2026, 0, 1, 4);
  try {
    const quota = createDrawToolQuota({ filePath, now: () => now });
    assert.equal(quota.check({ cooldownMs: 60_000, dailyLimit: 2 }).ok, true);
    quota.record();
    assert.equal(quota.usedToday(), 1);

    const cooling = quota.check({ cooldownMs: 60_000, dailyLimit: 2 });
    assert.equal(cooling.ok, false);
    assert.equal(cooling.reason, 'cooldown');
    assert.ok(cooling.retryAfterMs > 0);

    // 重启后仍然读得到今日计数与最后时间。
    const restarted = createDrawToolQuota({ filePath, now: () => now });
    assert.equal(restarted.usedToday(), 1);
    assert.equal(restarted.check({ cooldownMs: 60_000, dailyLimit: 2 }).reason, 'cooldown');

    now += 61_000;
    assert.equal(restarted.check({ cooldownMs: 60_000, dailyLimit: 2 }).ok, true);
    restarted.record();
    const limited = restarted.check({ cooldownMs: 0, dailyLimit: 2 });
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, 'daily-limit');

    now += 24 * 60 * 60_000;
    assert.equal(restarted.check({ cooldownMs: 60_000, dailyLimit: 2 }).ok, true);
    assert.equal(restarted.usedToday(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
