#!/usr/bin/env node
// Adds Cabin World to DeepSeek Harness (DSH):
//   1. an MCP server entry in <DSH home>/cordis.patch.yml, inside a marked block (replaced on reinstall, removed on --uninstall)
//   2. the cabin-world skill in <DSH home>/skills/cabin-world/SKILL.md
// DSH home: %DSH_HOME% if set, else %USERPROFILE%\.dsh. The previous cordis.patch.yml is kept as cordis.patch.yml.bak-cabin-world.
// Refuses if an entry with id "mcp-cabin-world" exists outside the marked block (someone else's entry). Restart DSH afterwards.
// Usage: node install-dsh.mjs [--uninstall] [--dsh-home <folder>]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const home = path.resolve(opt('--dsh-home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const patch = path.join(home, 'cordis.patch.yml'), skillDir = path.join(home, 'skills', 'cabin-world');
const BEGIN = '# === cabin-world MCP BEGIN ===', END = '# === cabin-world MCP END ===';
const server = path.resolve(HERE, '..', '..', 'mcp-server.mjs'), dataDir = path.resolve(HERE, '..', '..', '..', 'data');
const q = s => "'" + String(s).replaceAll("'", "''") + "'";
const block = [BEGIN, '# 小屋世界 Cabin World：由 install-dsh.mjs 维护；重新安装会整体替换这段，--uninstall 会删除它。', '- insert:', '    - id: mcp-cabin-world',
  "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: cabin-world', '        transport: stdio',
  '        command: ' + q(process.execPath), '        args:', '          - ' + q(server), "          - '--data'", '          - ' + q(dataDir),
  '        toolCallTimeoutMs: 660000', END].join('\n');

if (!fs.existsSync(home)) { console.error('找不到 DSH 的文件夹：' + home + '。先装好并打开一次 DeepSeek Harness，或用 --dsh-home 指定。'); process.exit(2); }
const before = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '';
const outside = before.replace(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
if (/id:\s*mcp-cabin-world\b/.test(outside)) { console.error('cordis.patch.yml 里已经有别人写的 mcp-cabin-world 条目，没有修改。请手动检查：' + patch); process.exit(3); }
const kept = outside.replace(/\n{3,}/g, '\n\n').trimEnd();
const after = args.includes('--uninstall') ? kept + '\n' : (kept ? kept + '\n\n' : '') + block + '\n';
if (before) fs.copyFileSync(patch, patch + '.bak-cabin-world');
fs.writeFileSync(patch + '.tmp', after); fs.renameSync(patch + '.tmp', patch);
if (args.includes('--uninstall')) { fs.rmSync(skillDir, { recursive: true, force: true }); console.log('已从 DSH 移除小屋世界。重启 DSH 生效。备份：' + patch + '.bak-cabin-world'); process.exit(0); }
fs.mkdirSync(skillDir, { recursive: true }); fs.copyFileSync(path.join(HERE, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
console.log('已把小屋世界加入 DSH：\n  MCP 服务器 cabin-world → ' + server + '\n  技能 → ' + skillDir + '\n  原配置备份 → ' + patch + '.bak-cabin-world\n先用 start.cmd 打开小屋世界，再重启 DSH。');
