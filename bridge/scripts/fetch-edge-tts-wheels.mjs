// 下载 edge-tts 及其全部运行依赖的 wheel 到 state 同级临时目录。
// 与 setup-edge-tts.ps1 配套；单独跑也可以。
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.EDGE_TTS_WHEEL_DIR || 'D:\\deepseek\\tmp\\edgetts-tmp\\wheels';
const ROOT_PACKAGES = ['edge-tts'];
// 直接依赖 + aiohttp 的传递依赖，全部显式列出，避免漏项。
const EXTRA = ['aiohttp', 'certifi', 'tabulate', 'typing-extensions',
  'aiohappyeyeballs', 'aiosignal', 'async-timeout', 'attrs', 'frozenlist',
  'idna', 'multidict', 'propcache', 'yarl'];

await mkdir(OUT, { recursive: true });
const wanted = new Map();
for (const name of [...ROOT_PACKAGES, ...EXTRA]) wanted.set(name.toLowerCase(), name);

for (const [key, name] of wanted) {
  const r = await fetch(`https://pypi.org/pypi/${name}/json`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const json = await r.json();
  const files = json.releases[json.info.version] ?? [];
  const wheel = files.find((f) => f.filename.endsWith('.whl')
    && (/py3-none-any/.test(f.filename) || /cp312-cp312-win_amd64/.test(f.filename)));
  if (!wheel) throw new Error(`${name}: 找不到可用 wheel`);
  const res = await fetch(wheel.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download ${wheel.filename}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(OUT, wheel.filename), buf);
  console.log(`${wheel.filename} (${buf.length} bytes)`);
}
console.log('ALL WHEELS DOWNLOADED');
