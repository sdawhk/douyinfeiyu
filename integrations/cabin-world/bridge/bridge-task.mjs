// 计划任务启动小屋桥时没有控制台，stdout 会直接丢掉，出问题只能靠猜。
// 这个包装把桥的输出接进 data/world/bridge-autonomy.stdout.log，行为与直接跑 bridge.mjs 一致。
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, '..', 'data', 'world');
mkdirSync(LOG_DIR, { recursive: true });
const fd = openSync(path.join(LOG_DIR, 'bridge-autonomy.stdout.log'), 'a');

const child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs'), '--config', 'bridge.config.json'], {
  cwd: HERE,
  stdio: ['ignore', fd, fd],
  windowsHide: true,
  env: process.env,
});

const stop = () => { try { child.kill(); } catch { /* ignore */ } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code, signal) => process.exit(typeof code === 'number' ? code : signal ? 1 : 0));
