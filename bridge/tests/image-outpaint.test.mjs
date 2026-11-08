import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodePng, measureComposition, measureHeadBodyRatio, planOutpaintOffsets, COMPOSITION_TARGET
} from '../src/image-composition.mjs';
import { outpaintImage, OUTPAINT_COST_CNY } from '../src/image-outpaint.mjs';
import { generateImage, normalizeImageGenConfig, normalizeOutpaintConfig } from '../src/image-gen.mjs';

// ── 合成 PNG：纯灰背景 + 一块黑色“人物”，用来做像素测量的确定性测试 ──────────
const table = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function syntheticPng(width, height, person = { top: 90, bottom: 700 }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height, 128);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const inside = y >= person.top && y <= person.bottom && x >= width * 0.3 && x <= width * 0.7;
      if (!inside) continue;
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function dashscopeResponse(buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      request_id: 'gen-1',
      output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${buffer.toString('base64')}` }] } }] }
    })
  };
}

// 有脸的“人物”：深色身体 + 肤色头部，用来验证头身比（headHeight 越小头身比越大）。
function figurePng(width, height, { top = 60, bottom = 830, headHeight = 100 } = {}) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height, 128);
  const bodyX0 = Math.round(width * 0.4);
  const bodyX1 = Math.round(width * 0.6);
  const faceX0 = Math.round(width * 0.22);
  const faceX1 = Math.round(width * 0.78);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      let rgb = null;
      if (y >= top && y <= top + headHeight && x >= faceX0 && x <= faceX1) rgb = [235, 175, 145];
      else if (y >= top && y <= bottom && x >= bodyX0 && x <= bodyX1) rgb = [20, 30, 40];
      if (!rgb) continue;
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('构图口径：人物 65–72%、头顶 12–15%、脚底 15–20%', () => {
  assert.deepEqual(COMPOSITION_TARGET.person, { min: 0.65, max: 0.72 });
  assert.deepEqual(COMPOSITION_TARGET.headroom, { min: 0.12, max: 0.15 });
  assert.deepEqual(COMPOSITION_TARGET.footspace, { min: 0.15, max: 0.20 });
});

test('像素测量：解 PNG 并算出人物占比、头顶、脚底留白', () => {
  const png = syntheticPng(300, 900, { top: 90, bottom: 700 });
  assert.ok(decodePng(png));
  const measure = measureComposition(png);
  assert.ok(measure);
  assert.equal(measure.width, 300);
  assert.equal(measure.height, 900);
  assert.ok(Math.abs(measure.headTopPx - 90) <= 1, `头顶像素 ${measure.headTopPx}`);
  assert.ok(Math.abs(measure.feetBottomPx - 700) <= 1, `脚底像素 ${measure.feetBottomPx}`);
  assert.ok(Math.abs(measure.personHeightPx - 611) <= 2, `人物像素 ${measure.personHeightPx}`);
  assert.ok(Math.abs(measure.personRatio - 611 / 900) < 0.01, `占比 ${measure.personRatio}`);
  assert.ok(Math.abs(measure.headroom - 0.1) < 0.01, `头顶 ${measure.headroom}`);
  assert.ok(Math.abs(measure.footspace - (899 - 700) / 900) < 0.01, `脚底 ${measure.footspace}`);
  // 非 PNG 不猜。
  assert.equal(measureComposition(Buffer.from('not an image')), null);
});

test('扩图偏移：向下 25%–35%、向上 8%–10%，并受接口上限约束', () => {
  const normal = planOutpaintOffsets({ width: 1024, height: 1536, downScale: 0.25, upScale: 0.09 });
  assert.equal(normal.topOffset, Math.round(1536 * 0.09));
  assert.equal(normal.bottomOffset, Math.round(1536 * 0.25));
  assert.equal(normal.height, 1536 + normal.topOffset + normal.bottomOffset);
  // 极端值收敛到上限以内（top+bottom < 3×高度）。
  const huge = planOutpaintOffsets({ width: 512, height: 512, downScale: 0.35, upScale: 0.10 });
  assert.ok(huge.topOffset + huge.bottomOffset < 512 * 3);

  const config = normalizeOutpaintConfig({ enabled: true, threshold: 2, downScale: 0.9, upScale: 0.01 });
  assert.equal(config.threshold, 0.99);
  assert.equal(config.downScale, 0.35);
  assert.equal(config.upScale, 0.08);
  assert.equal(normalizeOutpaintConfig({}).enabled, false, '默认必须关闭');
});

test('扩图接口：异步任务创建 → 轮询 → 下载', async () => {
  const png = syntheticPng(64, 96, { top: 10, bottom: 60 });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.endsWith('/image-synthesis')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'req-1' })
      };
    }
    if (url.endsWith('/tasks/task-1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: { task_id: 'task-1', task_status: 'SUCCEEDED', output_image_url: 'https://example.com/out.png' } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
    };
  };
  const result = await outpaintImage({
    buffer: png, mime: 'image/png', apiKey: 'test-key', width: 64, height: 96,
    topOffset: 9, bottomOffset: 24, fetchImpl, sleep: async () => {}
  });
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(result.taskId, 'task-1');
  assert.equal(result.mime, 'image/png');
  assert.ok(result.buffer.length > 0);
  const create = calls[0];
  assert.match(create.url, /\/services\/aigc\/image2image\/image-synthesis$/);
  assert.equal(create.method, 'POST');
  const body = JSON.parse(create.body);
  assert.equal(body.model, 'wanx2.1-imageedit');
  assert.equal(body.input.function, 'expand');
  assert.match(body.input.prompt, /补全延伸的背景/);
  // 像素偏移换算成扩展倍数：9/96≈0.094、24/96=0.25。
  assert.ok(Math.abs(body.parameters.top_scale - 1.09375) < 0.001, `top_scale ${body.parameters.top_scale}`);
  assert.ok(Math.abs(body.parameters.bottom_scale - 1.25) < 0.001, `bottom_scale ${body.parameters.bottom_scale}`);
  assert.equal(body.parameters.left_scale, 1);
  assert.equal(body.parameters.right_scale, 1);
  assert.equal(body.parameters.n, 1);
  assert.match(body.input.base_image_url, /^data:image\/png;base64,/);
});

test('扩图失败不阻塞出图：保留原图并记 meta', async () => {
  const original = syntheticPng(300, 900, { top: 60, bottom: 830 });
  const stateDir = mkdtempSync(join(tmpdir(), 'outpaint-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    outpaint: { enabled: true, threshold: 0.8, downScale: 0.25, upScale: 0.09 }
  });
  const logs = [];
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: syntheticPng(300, 900, { top: 60, bottom: 830 }), mime: 'image/png' }]
    },
    {
      fetchImpl: async () => dashscopeResponse(original),
      outpaintImage: async () => { throw new Error('outpaint boom'); },
      logger: (line) => logs.push(line),
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(result.outpaint.triggered, true);
  assert.equal(result.outpaint.ok, false);
  assert.equal(result.outpaint.reason, 'error');
  assert.equal(result.outpaint.costCny, 0);
  assert.ok(result.outpaint.before.personRatio > 0.8);
  assert.equal(result.buffer.length, original.length);
  assert.ok(logs.some((line) => line.includes('outpaint-fail')));
});

test('扩图触发：占比超标才扩，扩完重新测量并记录耗时与费用', async () => {
  const original = syntheticPng(300, 900, { top: 60, bottom: 830 });
  const expanded = syntheticPng(300, 1125, { top: 60, bottom: 830 });
  const stateDir = mkdtempSync(join(tmpdir(), 'outpaint-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    outpaint: { enabled: true, threshold: 0.8, downScale: 0.25, upScale: 0.09 }
  });
  let called = 0;
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: original, mime: 'image/png' }]
    },
    {
      fetchImpl: async () => dashscopeResponse(original),
      outpaintImage: async () => {
        called += 1;
        return { ok: true, buffer: expanded, mime: 'image/png', ms: 1234, taskId: 'task-9', requestId: 'req-9' };
      },
      logger() {},
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(called, 1);
  assert.equal(result.outpaint.triggered, true);
  assert.equal(result.outpaint.ok, true);
  assert.equal(result.outpaint.ms, 1234);
  assert.equal(result.outpaint.taskId, 'task-9');
  assert.equal(result.outpaint.costCny, OUTPAINT_COST_CNY);
  assert.ok(result.outpaint.before.personRatio > 0.8);
  assert.ok(result.outpaint.after.personRatio < 0.7, `扩图后 ${result.outpaint.after.personRatio}`);
  assert.equal(result.meta.outpaint.costCny, OUTPAINT_COST_CNY);
  assert.equal(result.meta.outpaint.after.personRatio, result.outpaint.after.personRatio);
  assert.equal(result.size, '300x1125');
});

test('扩图开关关闭时完全不调用', async () => {
  const original = syntheticPng(300, 900, { top: 60, bottom: 830 });
  const stateDir = mkdtempSync(join(tmpdir(), 'outpaint-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    outpaint: { enabled: false }
  });
  let called = 0;
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: original, mime: 'image/png' }]
    },
    {
      fetchImpl: async () => dashscopeResponse(original),
      outpaintImage: async () => { called += 1; return null; },
      logger() {},
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(called, 0);
  assert.equal(result.outpaint.triggered, false);
  assert.equal(result.outpaint.reason, 'disabled');
});

test('头身比：头顶梯度 + 肤色下巴定位，返回身高/头高', () => {
  const normal = measureHeadBodyRatio(figurePng(300, 900, { headHeight: 120 }));
  assert.ok(normal, '应能量出头身比');
  assert.ok(Math.abs(normal.headTopPx - 60) <= 1, `头顶像素 ${normal.headTopPx}`);
  assert.ok(Math.abs(normal.headHeightPx - 121) <= 2, `头高 ${normal.headHeightPx}`);
  assert.ok(normal.headBodyRatio > 6 && normal.headBodyRatio < 7, `头身比 ${normal.headBodyRatio}`);

  const tall = measureHeadBodyRatio(figurePng(300, 900, { headHeight: 60 }));
  assert.ok(tall.headBodyRatio > 7.6, `该显得超标的图 ${tall.headBodyRatio}`);
  // 解不了图就不猜。
  assert.equal(measureHeadBodyRatio(Buffer.from('not an image')), null);
  assert.equal(normalizeOutpaintConfig({}).minFootspace, 0.005);
});

test('扩图门槛：脚已出画（脚底留白 ≤0.5%）直接跳过扩图', async () => {
  const original = syntheticPng(300, 900, { top: 60, bottom: 898 });
  const stateDir = mkdtempSync(join(tmpdir(), 'outpaint-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    proportionCheck: { enabled: false },
    outpaint: { enabled: true, threshold: 0.8, minFootspace: 0.005 }
  });
  let called = 0;
  const logs = [];
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: original, mime: 'image/png' }]
    },
    {
      fetchImpl: async () => dashscopeResponse(original),
      outpaintImage: async () => { called += 1; return null; },
      logger: (line) => logs.push(line),
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(result.outpaint.before.feetCut, true);
  assert.equal(called, 0, '脚出画时不允许扩图');
  assert.equal(result.outpaint.triggered, false);
  assert.equal(result.outpaint.reason, 'feet-cut');
  assert.ok(logs.some((line) => line.includes('reason=feet-cut')));
});

test('比例检测：头身比 >7.6 带强化约束重画一次，仍超标标 proportion-outlier', async () => {
  const tall = figurePng(300, 900, { headHeight: 60 });
  const stateDir = mkdtempSync(join(tmpdir(), 'proportion-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    outpaint: { enabled: false },
    proportionCheck: { enabled: true, maxHeads: 7.6 }
  });
  const prompts = [];
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: tall, mime: 'image/png' }]
    },
    {
      fetchImpl: async (url, init) => {
        prompts.push(JSON.parse(init.body).input.messages[0].content.at(-1).text);
        return dashscopeResponse(tall);
      },
      logger() {},
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(prompts.length, 2, '只重画一次');
  assert.doesNotMatch(prompts[0], /【严格比例】/);
  assert.match(prompts[1], /【严格比例】/);
  assert.doesNotMatch(prompts[1], /【背景与氛围】/);
  assert.equal(result.proportion.triggered, true);
  assert.equal(result.proportion.retried, true);
  assert.equal(result.proportion.outlier, true);
  assert.equal(result.meta.proportionOutlier, true);
  assert.equal(result.meta.proportion.maxHeads, 7.6);
});

test('比例检测：重画后达标就采用新图，并清掉 outlier 标记', async () => {
  const tall = figurePng(300, 900, { headHeight: 60 });
  const normal = figurePng(300, 900, { headHeight: 120 });
  const stateDir = mkdtempSync(join(tmpdir(), 'proportion-'));
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    apiKey: 'k',
    model: 'qwen-image-3.0',
    width: 300,
    height: 900,
    framing: 'full',
    referencePolicy: 'optional',
    outpaint: { enabled: false },
    proportionCheck: { enabled: true, maxHeads: 7.6 }
  });
  let calls = 0;
  const result = await generateImage(
    {
      description: '海边散步',
      config,
      target: '1',
      isGroup: false,
      isOwner: true,
      chatKey: 'private:1',
      referenceImages: [{ buffer: tall, mime: 'image/png' }]
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return dashscopeResponse(calls === 1 ? tall : normal);
      },
      logger() {},
      stateDir
    }
  );
  assert.equal(result.ok, true, result.error || result.reason);
  assert.equal(calls, 2);
  assert.ok(result.proportion.first.headBodyRatio > 7.6);
  assert.ok(result.proportion.second.headBodyRatio < 7.6);
  assert.equal(result.proportion.outlier, false);
  assert.equal(result.meta.proportionOutlier, false);
  assert.deepEqual(result.buffer, normal, '应换成头身比达标的新图');
});
