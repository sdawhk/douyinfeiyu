// 虚拟天气 / Virtual weather.
// 小屋世界自己不生成天气，只画宿主发来的读数。没有真实天气源时，桥用这里的确定性虚拟天气，
// 同一时刻无论算多少次结果都一样（按小时段取种子），不联网、不读取位置。
// The game never makes weather; it draws what the host sends. This deterministic generator is the
// bridge's default so the world is not stuck on "unknown". Replace it with real data via POST /v1/weather.
//
// reading 字段（游戏读取）/ fields the game reads:
//   kind  sunny|partly|overcast|fog|drizzle|rain|breezy|snow   name 中文名
//   rain 0..1  cloud 0..1  fog bool  snow bool  wind 0..4.4  windLevel 0..4  windAngle 度
//   temp °C  phase night|dawn|day|dusk  sun 0..1（晒到的阳光） darkness 0..1
const KINDS = {
  sunny: { name: '晴', rain: 0, cloud: .1, sun: 1 }, partly: { name: '多云', rain: 0, cloud: .45, sun: .7 },
  overcast: { name: '阴天', rain: 0, cloud: .9, sun: .2 }, fog: { name: '薄雾', rain: 0, cloud: .7, sun: .3, fog: true },
  drizzle: { name: '毛毛雨', rain: .35, cloud: .85, sun: .1 }, rain: { name: '阵雨', rain: .8, cloud: 1, sun: 0 },
  breezy: { name: '晴，有风', rain: 0, cloud: .25, sun: .9, windy: true }, snow: { name: '小雪', rain: 0, cloud: .85, sun: .15, snow: true },
};
const WEIGHTS = [['sunny', 5], ['partly', 4], ['overcast', 3], ['breezy', 2], ['drizzle', 2], ['rain', 1], ['fog', 1]];
const SEASON = [5, 7, 12, 18, 23, 27, 30, 29, 25, 19, 13, 7]; // 月平均气温曲线（虚拟）
const hash = n => { let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

/** @param {number} now ms since 1970  @param {number} utcOffsetHours 游戏界面按北京时间显示，默认 8 */
export function virtualWeather(now = Date.now(), utcOffsetHours = 8) {
  const local = new Date(now + utcOffsetHours * 3600000), hour = local.getUTCHours() + local.getUTCMinutes() / 60, month = local.getUTCMonth();
  const slot = Math.floor(now / (90 * 60000)); // 每 90 分钟一段天气
  let r = hash(slot) * WEIGHTS.reduce((a, [, w]) => a + w, 0), kind = 'sunny';
  for (const [k, w] of WEIGHTS) { if ((r -= w) <= 0) { kind = k; break; } }
  if ([11, 0, 1].includes(month) && kind === 'rain') kind = 'snow';
  const def = KINDS[kind], phase = hour < 5.5 || hour >= 19.5 ? 'night' : hour < 7 ? 'dawn' : hour >= 17.5 ? 'dusk' : 'day';
  const darkness = phase === 'night' ? .85 : phase === 'day' ? 0 : .35;
  const wind = Math.round(Math.min(4.4, (def.windy ? 2.8 : kind === 'rain' ? 2 : .6) + hash(slot + 7) * 1.4 + Math.sin(now / 420000) * .4) * 10) / 10;
  const temp = Math.round(((def.snow ? -1 : SEASON[month]) + Math.cos((hour - 15) / 24 * Math.PI * 2) * 5 - def.rain * 3 - def.cloud * 1.5) * 10) / 10;
  return { kind, name: def.name, rain: def.rain, cloud: def.cloud, fog: Boolean(def.fog), snow: Boolean(def.snow), wind,
    windLevel: Math.min(4, Math.round(wind)), windAngle: Math.floor(hash(slot + 3) * 8) * 45, temp, phase,
    sun: phase === 'night' ? 0 : Math.round(def.sun * (phase === 'day' ? 1 : .4) * 100) / 100, darkness };
}
