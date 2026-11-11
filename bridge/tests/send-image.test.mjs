import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_IMAGE_BYTES, decideImageSendAccess, loadImagePayload, parseSendKey
} from '../src/send-image.mjs';
import { decideDrawToolAccess } from '../src/image-draw-tool.mjs';

const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(96, 0)]);

test('send/image：key 解析', () => {
  assert.deepEqual(parseSendKey('private:1668389572'), { kind: 'private', id: 1668389572 });
  assert.deepEqual(parseSendKey(' group:839367702 '), { kind: 'group', id: 839367702 });
  assert.equal(parseSendKey('private:abc'), null);
  assert.equal(parseSendKey('group:123'), null);
  assert.equal(parseSendKey(''), null);
  assert.equal(parseSendKey(undefined), null);
});

test('send/image：鉴权闸门与文本发送一致', () => {
  assert.equal(decideImageSendAccess({ mode: 'chat' }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved' }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved2' }).ok, false);
  assert.match(decideImageSendAccess({ mode: 'reserved2' }).error, /agent token/);

  assert.equal(decideImageSendAccess({ mode: 'reserved2', token: 't', tokenValid: false }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved2', token: 't', tokenValid: true, toolEnabled: false }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved2', token: 't', tokenValid: true, silentBlocked: true }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved2', token: 't', tokenValid: true, targetAllowed: false }).ok, false);
  assert.equal(decideImageSendAccess({ mode: 'reserved2', token: 't', tokenValid: true }).ok, true);
  assert.equal(decideImageSendAccess({ mode: 'closed-agent' }).ok, true);
});

test('send/image：非主人会话拒绝（目标白名单），主人放行', () => {
  const owners = ['1668389572'];
  assert.equal(decideDrawToolAccess({ key: 'private:10000', owners }).allowed, false);
  // 路由把 modeAllowed 的结果传给 targetAllowed：非主人私聊在白名单外
  const blocked = decideImageSendAccess({
    mode: 'reserved2', token: 't', tokenValid: true, targetAllowed: owners.includes('10000')
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /目标/);
  assert.equal(decideImageSendAccess({
    mode: 'reserved2', token: 't', tokenValid: true, targetAllowed: owners.includes('1668389572')
  }).ok, true);
});

test('send/image：拒绝把图发给机器人自己', () => {
  const self = '2427256325';
  const rejected = decideImageSendAccess({
    mode: 'closed-agent', targetKey: `private:${self}`, selfId: self
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.error, '目标不能是机器人自己');

  // 发给别人照常放行；群聊里自己也是成员，不能误拦。
  assert.equal(decideImageSendAccess({ mode: 'closed-agent', targetKey: 'private:1668389572', selfId: self }).ok, true);
  assert.equal(decideImageSendAccess({ mode: 'closed-agent', targetKey: 'group:839367702', selfId: self }).ok, true);
  // 没传 selfId 时保持旧行为（不做自发判定）。
  assert.equal(decideImageSendAccess({ mode: 'closed-agent', targetKey: `private:${self}` }).ok, true);
});

test('send/image：base64 载荷（data URI 与纯 base64）', () => {
  const raw = PNG_BYTES.toString('base64');
  const fromBare = loadImagePayload(raw, { rootDir: tmpdir() });
  assert.equal(fromBare.ok, true);
  assert.equal(fromBare.source, 'base64');
  assert.deepEqual(fromBare.buffer, PNG_BYTES);

  const fromUri = loadImagePayload(`data:image/png;base64,${raw}`, { rootDir: tmpdir() });
  assert.equal(fromUri.ok, true);
  assert.equal(fromUri.source, 'base64');
  assert.deepEqual(fromUri.buffer, PNG_BYTES);

  const empty = loadImagePayload('   ', { rootDir: tmpdir() });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 400);
});

test('send/image：超大图拒绝（>5MB）', () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64');
  const result = loadImagePayload(big, { rootDir: tmpdir() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.match(result.error, /5MB/);
});

test('send/image：本地路径只允许 state/imagegen 目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sendimage-'));
  const root = join(dir, 'imagegen');
  mkdirSync(join(root, '2026-11-07'), { recursive: true });
  const inside = join(root, '2026-11-07', 'a.png');
  writeFileSync(inside, PNG_BYTES);
  const outside = join(dir, 'secret.png');
  writeFileSync(outside, PNG_BYTES);
  const outsideDir = join(dir, 'other');
  mkdirSync(outsideDir, { recursive: true });
  const sibling = join(outsideDir, 'b.png');
  writeFileSync(sibling, PNG_BYTES);
  const textFile = join(root, 'note.txt');
  writeFileSync(textFile, 'not an image');

  try {
    const good = loadImagePayload(inside, { rootDir: root });
    assert.equal(good.ok, true);
    assert.equal(good.source, 'path');
    assert.deepEqual(good.buffer, PNG_BYTES);

    const traversal = loadImagePayload(join(root, '..', 'secret.png'), { rootDir: root });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.status, 403);
    assert.match(traversal.error, /state\/imagegen/);

    const absoluteOutside = loadImagePayload(outside, { rootDir: root });
    assert.equal(absoluteOutside.ok, false);
    assert.equal(absoluteOutside.status, 403);

    const siblingDir = loadImagePayload(sibling, { rootDir: root });
    assert.equal(siblingDir.ok, false);
    assert.equal(siblingDir.status, 403);

    const notImage = loadImagePayload(textFile, { rootDir: root });
    assert.equal(notImage.ok, false);
    assert.equal(notImage.status, 400);

    const missing = loadImagePayload(join(root, 'missing.png'), { rootDir: root });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
