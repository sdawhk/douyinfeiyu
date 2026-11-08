#!/usr/bin/env node
// 人设卡体检：负向规则占比、AI 味黑名单、客服底座句、重复节奏。
// 用法：
//   node scripts/persona-audit.mjs bridge/roles/小鲸鱼.md
//   node scripts/persona-audit.mjs bridge/roles/小鲸鱼.md --strict --json
// 默认退出码 0（只报告）；--strict 时有命中或占比超阈值则退出 1，可接进回归测试。
import { readFileSync } from 'node:fs';

const NEGATIVE_RE = /(不要|禁止|必须|不准|不得|严禁|一律|不许|避免|切勿|勿要|不能)/u;
const ASSISTANT_RE = /(You are an?\b|你是.*(?:AI\s*)?助手|我是.*AI\s*助手|很高兴为您服务|礼貌拒绝|保持友善|不要显得疏远)/iu;
const BLACKLIST_RE = /(出现即失败|AI\s*味黑名单|黑名单|禁止出现)/iu;
const RHYTHM_RE = /(先.{0,8}(?:回答|答|接住|承认|理解|肯定).{0,8}再|再(?:补|加).{0,4}(?:一句|反应|性格))/u;

function parseArgs(argv) {
  const out = { file: '', json: false, strict: false, threshold: 0.25 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--json') out.json = true;
    else if (key === '--strict') out.strict = true;
    else if (key === '--threshold') {
      i += 1;
      out.threshold = Number(argv[i]);
    } else if (!key.startsWith('--')) out.file = key;
    else throw new Error(`未知参数 ${key}`);
  }
  if (!out.file) throw new Error('缺少角色卡路径');
  return out;
}

function audit(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const negative = nonEmpty.filter((line) => NEGATIVE_RE.test(line));
  const assistant = nonEmpty.filter((line) => ASSISTANT_RE.test(line));
  const blacklist = nonEmpty.filter((line) => BLACKLIST_RE.test(line));
  const rhythm = nonEmpty.filter((line) => RHYTHM_RE.test(line));
  const chars = Array.from(String(text)).length;
  return {
    chars,
    lines: nonEmpty.length,
    negativeLines: negative.length,
    negativeRatio: nonEmpty.length ? negative.length / nonEmpty.length : 0,
    buyaoLines: nonEmpty.filter((line) => line.includes('不要')).length,
    assistantLines: assistant.length,
    blacklistLines: blacklist.length,
    rhythmLines: rhythm.length,
    samples: {
      negative: negative.slice(0, 5),
      assistant: assistant.slice(0, 5),
      blacklist: blacklist.slice(0, 5),
      rhythm: rhythm.slice(0, 5)
    }
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[persona-audit] ${error.message}`);
    process.exit(2);
  }

  let text;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (error) {
    console.error(`[persona-audit] 读取失败：${error.message}`);
    process.exit(2);
  }

  const report = audit(text);
  const findings = [];
  if (report.negativeRatio > args.threshold) {
    findings.push(`负向规则占比 ${(report.negativeRatio * 100).toFixed(1)}% > 阈值 ${(args.threshold * 100).toFixed(0)}%`);
  }
  if (report.blacklistLines) findings.push(`命中 AI 味黑名单/威胁式表述 ${report.blacklistLines} 行，应移出 prompt 放进评测集`);
  if (report.assistantLines) findings.push(`命中助手/客服底座句 ${report.assistantLines} 行`);
  if (report.rhythmLines > 1) findings.push(`"先……再……"节奏规则出现 ${report.rhythmLines} 行，超过 1 处会固化成模板`);
  report.findings = findings;

  if (args.json) {
    console.log(JSON.stringify({ file: args.file, ...report }, null, 2));
  } else {
    console.log(`文件：${args.file}`);
    console.log(`字符数：${report.chars}，非空行：${report.lines}`);
    console.log(`负向/强制行：${report.negativeLines}（${(report.negativeRatio * 100).toFixed(1)}%），含"不要"：${report.buyaoLines} 行`);
    console.log(`助手/客服底座：${report.assistantLines} 行`);
    console.log(`AI 味黑名单/威胁式：${report.blacklistLines} 行`);
    console.log(`"先……再……"节奏：${report.rhythmLines} 行`);
    if (findings.length) {
      console.log('\n需要处理：');
      for (const item of findings) console.log(`- ${item}`);
      for (const [kind, samples] of Object.entries(report.samples)) {
        if (!samples.length) continue;
        console.log(`\n${kind} 样例：`);
        for (const line of samples) console.log(`  ${line.slice(0, 80)}`);
      }
    } else {
      console.log('\n未发现结构性问题（仍需用 15 句 A/B 验证语气）。');
    }
  }
  process.exit(args.strict && findings.length ? 1 : 0);
}

main();
