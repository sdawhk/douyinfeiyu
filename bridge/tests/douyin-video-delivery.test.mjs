import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DOUYIN_VIDEO_DEFAULTS, createDouyinVideoGate, douyinFallbackText, douyinVideoQueuePaths,
  matchDouyinShareLinks, preferredDouyinLinks, sendVideoWithRetry, significantTextBesideLinks,
  waitForDouyinVideoResponse, writeDouyinVideoRequest
} from '../src/douyin-video-delivery.mjs';

test('short links, full video links and wrapped text are all matched', () => {
  assert.deepEqual(matchDouyinShareLinks('https://v.douyin.com/iRxxo5yq/'), [
    { url: 'https://v.douyin.com/iRxxo5yq/', kind: 'short', key: 'short:iRxxo5yq' }
  ]);
  assert.deepEqual(matchDouyinShareLinks('看看这个 https://www.douyin.com/video/7671950211221047225 哈哈'), [
    { url: 'https://www.douyin.com/video/7671950211221047225', kind: 'video', key: 'id:7671950211221047225' }
  ]);
  // 无协议头、其他域名、B 站链接都不触发。
  assert.deepEqual(matchDouyinShareLinks('v.douyin.com/iRxxo5yq https://www.bilibili.com/video/BV1xx iesdouyin.com/x'), []);
  // 同一链接出现两次只算一次。
  assert.equal(matchDouyinShareLinks('https://v.douyin.com/abc123/ 和 https://v.douyin.com/abc123/').length, 1);
});

test('multiple links in one message are all captured', () => {
  const links = matchDouyinShareLinks('https://v.douyin.com/abc123/ https://www.douyin.com/video/1234567890');
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => link.key), ['id:1234567890', 'short:abc123']);
});

test('full video links win over short links in the same message', () => {
  const links = matchDouyinShareLinks('https://v.douyin.com/abc123/ https://www.douyin.com/video/111 https://www.douyin.com/video/222');
  const preferred = preferredDouyinLinks(links);
  assert.deepEqual(preferred.map((link) => link.key), ['id:111', 'id:222']);
  // 只有短链时取第一条。
  assert.deepEqual(preferredDouyinLinks(matchDouyinShareLinks('https://v.douyin.com/abc/ https://v.douyin.com/def/')),
    [{ url: 'https://v.douyin.com/abc/', kind: 'short', key: 'short:abc' }]);
});

test('share boilerplate is stripped so pure shares do not reach the model', () => {
  assert.equal(significantTextBesideLinks('7.02 pQg:/ 复制打开抖音，看看【某人】的视频 https://v.douyin.com/iRxxo5yq/',
    matchDouyinShareLinks('https://v.douyin.com/iRxxo5yq/')), '');
  assert.equal(significantTextBesideLinks('https://www.douyin.com/video/1234567890',
    matchDouyinShareLinks('https://www.douyin.com/video/1234567890')), '');
  const keep = significantTextBesideLinks('这个视频怎么样 https://www.douyin.com/video/1234567890',
    matchDouyinShareLinks('https://www.douyin.com/video/1234567890'));
  assert.match(keep, /这个视频怎么样/);
});

function makeGate(config, clock) {
  let now = clock ?? 1_000_000;
  const gate = createDouyinVideoGate({ config, now: () => now });
  return { gate, advance: (ms) => { now += ms; } };
}

const BASE_CONFIG = { enabled: true, groups: ['123'], privateEnabled: true };
const SHORT_LINK = { url: 'https://v.douyin.com/abc123/', kind: 'short', key: 'short:abc123' };

test('gate: disabled, whitelist, owner bypass and private switch', () => {
  const linkOf = (code) => ({ url: `https://v.douyin.com/${code}/`, kind: 'short', key: `short:${code}` });
  const disabled = makeGate({ ...BASE_CONFIG, enabled: false });
  assert.equal(disabled.gate.check({ isGroup: true, target: 123, sender: '9', isOwner: false, links: [linkOf('a1')] }).reason, 'disabled');
  const whitelisted = makeGate(BASE_CONFIG);
  assert.equal(whitelisted.gate.check({ isGroup: true, target: 456, sender: '9', isOwner: false, links: [linkOf('a2')] }).reason, 'group-not-whitelisted');
  assert.equal(whitelisted.gate.check({ isGroup: true, target: 456, sender: '9', isOwner: true, links: [linkOf('a3')] }).reason, 'ok');
  assert.equal(whitelisted.gate.check({ isGroup: false, target: '9', sender: '9', isOwner: false, links: [linkOf('a4')] }).reason, 'ok');
  const privateOff = makeGate({ ...BASE_CONFIG, privateEnabled: false });
  assert.equal(privateOff.gate.check({ isGroup: false, target: '9', sender: '9', isOwner: false, links: [linkOf('a5')] }).reason, 'private-disabled');
});

test('gate: global dedup by canonical key within TTL', () => {
  const { gate, advance } = makeGate(BASE_CONFIG);
  assert.equal(gate.check({ isGroup: true, target: 123, sender: '9', isOwner: false, links: [SHORT_LINK] }).reason, 'ok');
  // 同一个白名单群里另一个人发同一个短链：30 分钟内直接去重。
  assert.equal(gate.check({ isGroup: true, target: 123, sender: '8', isOwner: false, links: [SHORT_LINK] }).reason, 'duplicate');
  advance(31 * 60_000);
  assert.equal(gate.check({ isGroup: true, target: 123, sender: '9', isOwner: false, links: [SHORT_LINK] }).reason, 'ok');
  // 短链发过之后，解析出的真实 id 也可以被补记去重（完整链接形态）。
  gate.markResolved('id:7671950211221047225');
  advance(10_000);
  assert.equal(gate.check({ isGroup: true, target: 123, sender: '7', isOwner: true,
    links: [{ url: 'https://www.douyin.com/video/7671950211221047225', kind: 'video', key: 'id:7671950211221047225' }] }).reason, 'duplicate');
});

test('gate: per-chat cooldown and duplicate keys inside one message', () => {
  const { gate, advance } = makeGate({ ...BASE_CONFIG, cooldownSeconds: 60 });
  const first = gate.check({ isGroup: true, target: 123, sender: '9', isOwner: false, links: [SHORT_LINK] });
  assert.equal(first.reason, 'ok');
  // 同一条消息里两个不同写法的完整链接指向同一视频，只搬一次。
  const dupKeys = [
    { url: 'https://www.douyin.com/video/111', kind: 'video', key: 'id:111' },
    { url: 'https://www.douyin.com/video/111?from=share', kind: 'video', key: 'id:111' }
  ];
  const second = gate.check({ isGroup: true, target: 456, sender: '8', isOwner: true, links: dupKeys });
  assert.equal(second.reason, 'ok');
  assert.equal(second.links.length, 1);
  advance(30_000);
  // 冷却期内同群另一个视频也不触发（同群去抖）。
  assert.equal(gate.check({ isGroup: true, target: 456, sender: '8', isOwner: true,
    links: [{ url: 'https://www.douyin.com/video/222', kind: 'video', key: 'id:222' }] }).reason, 'cooldown');
  advance(31_000);
  assert.equal(gate.check({ isGroup: true, target: 456, sender: '8', isOwner: true,
    links: [{ url: 'https://www.douyin.com/video/222', kind: 'video', key: 'id:222' }] }).reason, 'ok');
});

test('request file is queued and the response round-trip works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-video-queue-'));
  try {
    const id = writeDouyinVideoRequest({ requestDir: dir, url: 'https://v.douyin.com/abc123/', maxVideoMB: 95 });
    assert.match(id, /^[0-9a-f]{32}$/);
    const paths = douyinVideoQueuePaths(dir);
    const queued = readdirSync(paths.queueDir);
    assert.equal(queued.length, 1);
    const payload = JSON.parse(readFileSync(join(paths.queueDir, queued[0]), 'utf8'));
    assert.equal(payload.id, id);
    assert.deepEqual(payload.urls, ['https://v.douyin.com/abc123/']);
    assert.equal(payload.maxVideoMB, 95);
    // 模拟 worker 写响应，然后等待方应该读到并清掉响应文件。
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 30));
    setTimeout(() => {
      writeFileSync(paths.response(id), JSON.stringify({ ok: true, videoPath: 'D:/x.mp4', awemeId: '42' }), 'utf8');
    }, 60);
    const response = await waitForDouyinVideoResponse({ requestDir: dir, id, timeoutMs: 2000, pollMs: 20, sleep });
    assert.equal(response.ok, true);
    assert.equal(response.awemeId, '42');
    // 超时路径：返回 timeout 标记而不是抛错。
    const timedOut = await waitForDouyinVideoResponse({ requestDir: dir, id, timeoutMs: 40, pollMs: 10, sleep });
    assert.equal(timedOut.timeout, true);
    assert.equal(timedOut.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendVideoWithRetry retries once and reports failure without a stack', async () => {
  const attempts = [];
  const flaky = {
    send: async () => { attempts.push(1); if (attempts.length < 2) throw new Error('TCP connect timeout'); }
  };
  const recovered = await sendVideoWithRetry({ ...flaky, retryDelayMs: 1, sleep: async () => {} });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempts, 2);
  const alwaysFails = { send: async () => { attempts.push(1); throw new Error('boom'); } };
  const failed = await sendVideoWithRetry({ ...alwaysFails, retryDelayMs: 1, sleep: async () => {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 2);
  assert.equal(failed.error, 'boom');
});

test('fallback text: oversize degrades to title + link, failures stay one line', () => {
  const oversize = douyinFallbackText({
    response: { ok: true, oversize: true, title: '纯绿是你的谎言', sizeBytes: 104_857_600 },
    shareUrl: 'https://v.douyin.com/abc123/', maxVideoMB: 95
  });
  assert.match(oversize, /《纯绿是你的谎言》有 100MB，超过 95MB/);
  assert.match(oversize, /https:\/\/v\.douyin\.com\/abc123\//);
  const timeout = douyinFallbackText({ response: { ok: false, timeout: true }, shareUrl: 'https://v.douyin.com/x/', maxVideoMB: 95 });
  assert.match(timeout, /超时/);
  const gallery = douyinFallbackText({ response: { ok: false, error: '图集' }, shareUrl: 'https://v.douyin.com/x/', maxVideoMB: 95 });
  assert.match(gallery, /图集/);
  const generic = douyinFallbackText({
    response: { ok: false, error: 'Traceback (most recent call last): ...' },
    shareUrl: 'https://v.douyin.com/x/', maxVideoMB: 95
  });
  assert.ok(!generic.includes('Traceback'));
  assert.equal(generic, '这条抖音视频没搬过来，稍后再试或直接点链接看：https://v.douyin.com/x/');
});

test('defaults keep the agreed limits', () => {
  assert.equal(DOUYIN_VIDEO_DEFAULTS.maxVideoMB, 95);
  assert.equal(DOUYIN_VIDEO_DEFAULTS.cooldownSeconds, 60);
  assert.equal(DOUYIN_VIDEO_DEFAULTS.dedupMinutes, 30);
});
