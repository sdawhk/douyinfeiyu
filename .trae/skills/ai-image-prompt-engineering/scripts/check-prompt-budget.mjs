#!/usr/bin/env node
// 生图提示词预算自检：量实际发送长度、模拟服务端截断、标出被截掉的层。
// 用法：
//   node scripts/check-prompt-budget.mjs --positive-file p.txt --negative-file n.txt
//   node scripts/check-prompt-budget.mjs --positive "..." --negative "..."
//   node scripts/check-prompt-budget.mjs --positive "..." --positive-max 780 --token-limit 800 --json
// 退出码：0 未超限；1 任一硬上限超限或被截断风险；2 参数错误。
import { readFileSync } from 'node:fs';

const DEFAULTS = { positiveMax: 780, negativeMax: 480, tokenLimit: 800 };

function parseArgs(argv) {
  const out = { ...DEFAULTS, positive: '', negative: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`参数 ${key} 缺少取值`);
      return argv[i];
    };
    if (key === '--positive') out.positive = next();
    else if (key === '--negative') out.negative = next();
    else if (key === '--positive-file') out.positive = readFileSync(next(), 'utf8');
    else if (key === '--negative-file') out.negative = readFileSync(next(), 'utf8');
    else if (key === '--positive-max') out.positiveMax = Number(next());
    else if (key === '--negative-max') out.negativeMax = Number(next());
    else if (key === '--token-limit') out.tokenLimit = Number(next());
    else if (key === '--json') out.json = true;
    else throw new Error(`未知参数 ${key}`);
  }
  return out;
}

const isWide = (ch) => ch.codePointAt(0) >= 0x2e80;
const charLength = (text) => Array.from(text).length;

// 保守估算：CJK 一字≈1 token，其余约 4 字符≈1 token。
function estimateTokens(text) {
  let tokens = 0;
  for (const ch of String(text)) tokens += isWide(ch) ? 1 : 0.25;
  return Math.round(tokens * 100) / 100;
}

function labelOf(segment) {
  const match = /^【([^】]+)】/.exec(segment.trim());
  return match ? match[1] : '';
}

// 按分隔符切成段，同时记录每段的字符起点、token 起点与是否越过 token 上限。
function segmentize(text, separator, tokenLimit) {
  const rows = [];
  if (!String(text).trim()) return { rows, chars: 0, tokens: 0 };
  let charStart = 0;
  let tokenStart = 0;
  let chars = 0;
  let tokens = 0;
  const segments = String(text).split(separator);
  segments.forEach((segment, index) => {
    const segmentChars = charLength(segment) + (index < segments.length - 1 ? 1 : 0);
    const segmentTokens = estimateTokens(segment) + (index < segments.length - 1 ? 1 : 0);
    rows.push({
      index: index + 1,
      label: labelOf(segment) || segment.trim().slice(0, 18),
      charStart,
      charEnd: charStart + segmentChars,
      tokenStart: Math.round(tokenStart * 100) / 100,
      tokenEnd: Math.round((tokenStart + segmentTokens) * 100) / 100,
      truncated: tokenStart >= tokenLimit,
      partial: tokenStart < tokenLimit && tokenStart + segmentTokens > tokenLimit
    });
    charStart += segmentChars;
    tokenStart += segmentTokens;
    chars += segmentChars;
    tokens += segmentTokens;
  });
  return { rows, chars, tokens: Math.round(tokens * 100) / 100 };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[prompt-budget] ${error.message}`);
    process.exit(2);
  }
  if (!args.positive && !args.negative) {
    console.error('[prompt-budget] 至少提供 --positive 或 --negative（也可用 *-file）');
    process.exit(2);
  }

  const positive = args.positive.trim();
  const negative = args.negative.trim();
  const positiveScan = segmentize(positive, '；', args.tokenLimit);
  const negativeScan = segmentize(negative, '、', args.negativeMax);

  const issues = [];
  if (positiveScan.chars > args.positiveMax) {
    issues.push(`正向 ${positiveScan.chars} 字符 > 上限 ${args.positiveMax}`);
  }
  if (estimateTokens(positive) > args.tokenLimit) {
    issues.push(`正向估算 ${estimateTokens(positive)} token > 上限 ${args.tokenLimit}`);
  }
  if (negativeScan.chars > args.negativeMax) {
    issues.push(`负向 ${negativeScan.chars} 字符 > 上限 ${args.negativeMax}`);
  }
  const lost = positiveScan.rows.filter((row) => row.truncated).length;
  const partial = positiveScan.rows.filter((row) => row.partial).length;
  if (lost || partial) {
    issues.push(`按 ${args.tokenLimit} token 截断：${lost} 段完全丢失，${partial} 段被切半`);
  }

  const report = {
    positive: {
      chars: positiveScan.chars,
      estimatedTokens: estimateTokens(positive),
      maxChars: args.positiveMax,
      tokenLimit: args.tokenLimit,
      segments: positiveScan.rows
    },
    negative: {
      chars: negativeScan.chars,
      maxChars: args.negativeMax,
      terms: negativeScan.rows.map((row) => ({
        index: row.index,
        term: row.label,
        charStart: row.charStart,
        charEnd: row.charEnd,
        truncated: row.charStart >= args.negativeMax
      }))
    },
    ok: issues.length === 0,
    issues
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`正向 ${positiveScan.chars}/${args.positiveMax} 字符，估算 ${report.positive.estimatedTokens}/${args.tokenLimit} token`);
    for (const row of positiveScan.rows) {
      const mark = row.truncated ? 'LOST' : (row.partial ? 'CUT ' : 'ok  ');
      console.log(`  ${mark} #${row.index} ${String(row.charStart).padStart(4)}-${String(row.charEnd).padStart(4)} 字符  ${row.label}`);
    }
    console.log(`负向 ${negativeScan.chars}/${args.negativeMax} 字符`);
    for (const row of negativeScan.rows) {
      const mark = row.truncated ? 'LOST' : 'ok  ';
      console.log(`  ${mark} #${row.index} @${row.charStart}  ${row.label}`);
    }
    if (issues.length) console.log(`\n不通过：\n- ${issues.join('\n- ')}`);
    else console.log('\n通过：正负向均在预算内，且按当前 token 上限没有被切掉的层。');
  }
  process.exit(report.ok ? 0 : 1);
}

main();
