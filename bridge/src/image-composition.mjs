// 构图量化：不靠目测，直接从图片字节里量人物 bbox。
// 只解 PNG（qwen / 扩图输出都是 PNG），解不了就返回 null，调用方跳过扩图而不是猜。
import { inflateSync } from 'node:zlib';

// 构图验收口径（占画幅高度）：
//   人物 65%–72% + 头顶留白 12%–15% + 脚底留白 15%–20% = 92%–107%，
// 三者不必独立取上限，按 100% 约束配合取值（例：人物 70%、头顶 13%、脚底 17%）。
export const COMPOSITION_TARGET = Object.freeze({
  person: Object.freeze({ min: 0.65, max: 0.72 }),
  headroom: Object.freeze({ min: 0.12, max: 0.15 }),
  footspace: Object.freeze({ min: 0.15, max: 0.20 })
});

/** 解 8bit PNG（colorType 0/2/4/6），返回 RGB 行数据；不支持就返回 null。 */
export function decodePng(buffer) {
  const buf = Buffer.from(buffer ?? []);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || !width || !height || !idat.length) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp++];
    const rowStart = rp;
    rp += stride;
    const prevStart = (y - 1) * stride;
    const curStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[curStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let v = raw[rowStart + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      out[curStart + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * 量人物 bbox：逐行做梯度能量统计，取中央 18%–82% 列。
 * 复杂背景（窗边、街景）用阈值 = max(24, 峰值*0.12)，纯色背景同样适用。
 */
export function measureComposition(buffer) {
  const img = decodePng(buffer);
  if (!img) return null;
  const { width, height, channels, data } = img;
  if (width < 64 || height < 64) return null;
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      gray[y * width + x] = channels >= 3
        ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        : data[i];
    }
  }
  const x0 = Math.floor(width * 0.18);
  const x1 = Math.floor(width * 0.82);
  const rowScore = new Float64Array(height);
  let peak = 0;
  for (let y = 1; y < height - 1; y += 1) {
    let score = 0;
    for (let x = x0; x < x1 - 1; x += 1) {
      const p = y * width + x;
      const g = Math.abs(gray[p + 1] - gray[p - 1]) + Math.abs(gray[p + width] - gray[p - width]);
      if (g > 26) score += Math.min(3, g / 26);
    }
    rowScore[y] = score;
    if (score > peak) peak = score;
  }
  const threshold = Math.max(24, peak * 0.12);
  let headTopPx = -1;
  let feetBottomPx = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowScore[y] >= threshold) { headTopPx = y; break; }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    if (rowScore[y] >= threshold) { feetBottomPx = y; break; }
  }
  if (headTopPx < 0 || feetBottomPx < 0) return null;
  const personHeightPx = feetBottomPx - headTopPx + 1;
  const ratio = (value) => Math.round((value / height) * 10000) / 10000;
  return {
    width,
    height,
    headTopPx,
    feetBottomPx,
    personHeightPx,
    personRatio: ratio(personHeightPx),
    headroom: ratio(headTopPx),
    footspace: ratio(height - 1 - feetBottomPx),
    // 脚底贴到画面最后一两行就是出画：扩图续画会接出畸形脚，必须跳过。
    feetCut: feetBottomPx >= height - 2
  };
}

/**
 * 头身比：头顶沿用 measureComposition 的梯度定位（含头发体积），
 * 下巴按“脸最宽处向下、肤色宽度连续三行跌破 45%”定位，返回 身高 / 头高。
 * 只在人物上半部分扫肤色，避免手与腿的肤色干扰；找不到脸返回 null，不猜。
 */
export function measureHeadBodyRatio(buffer) {
  const img = decodePng(buffer);
  if (!img) return null;
  const comp = measureComposition(buffer);
  if (!comp) return null;
  const { width, height, channels, data } = img;
  const isSkin = (r, g, b) => r > 150 && g > 105 && b > 95 && r > g && g >= b - 8 && r - b > 22 && r - b < 110;
  const scanBottom = Math.min(height, Math.round(comp.headTopPx + comp.personHeightPx * 0.55));
  const rows = [];
  for (let y = comp.headTopPx; y < scanBottom; y += 1) {
    let count = 0;
    for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.8); x += 1) {
      const i = (y * width + x) * channels;
      if (isSkin(data[i], data[i + 1], data[i + 2])) count += 1;
    }
    rows.push({ y, count });
  }
  if (!rows.length) return null;
  const peak = rows.reduce((best, row) => (row.count > best.count ? row : best), { count: 0, y: 0 });
  // 肤色少于 6 像素认为没找到脸，宁可返回 null 也不上报假比例。
  if (peak.count < 6) return null;
  const peakIndex = rows.findIndex((row) => row.y === peak.y);
  let chin = -1;
  for (let i = peakIndex; i >= 0 && i < rows.length - 3; i += 1) {
    if (rows[i].count < peak.count * 0.45
      && rows[i + 1].count < peak.count * 0.45
      && rows[i + 2].count < peak.count * 0.45) {
      chin = rows[i].y;
      break;
    }
  }
  const headHeightPx = chin > comp.headTopPx ? chin - comp.headTopPx : 0;
  if (!headHeightPx) return null;
  return {
    headTopPx: comp.headTopPx,
    chinRow: chin,
    facePeakRow: peak.y,
    faceWidthPx: peak.count,
    headHeightPx,
    personHeightPx: comp.personHeightPx,
    headBodyRatio: Math.round((comp.personHeightPx / headHeightPx) * 100) / 100
  };
}

/** 扩图像素偏移：按用户口径向下 25%–35%、向上 8%–10%（相对原图高度）。 */
export function planOutpaintOffsets({ width, height, downScale = 0.25, upScale = 0.09 }) {
  const topOffset = Math.max(0, Math.round(height * upScale));
  const bottomOffset = Math.max(0, Math.round(height * downScale));
  // 接口限制：top_offset + bottom_offset < 3×输入高度，这里留一点余量。
  const limit = Math.floor(height * 2.9);
  const total = topOffset + bottomOffset;
  const scale = total > limit ? limit / total : 1;
  return {
    topOffset: Math.floor(topOffset * scale),
    bottomOffset: Math.floor(bottomOffset * scale),
    width: width + 0,
    height: height + topOffset + bottomOffset
  };
}
