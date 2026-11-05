// 抖音浏览任务的持久状态与监听器心跳判定。
//
// 之前 job 只存在 bridge 内存里：bridge 一重启，status 就 404，模型只能报“状态未知”。
// 这里把 job 落盘，并给 running 加一个确定的超时终态，避免无限 running。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BROWSE_JOB_TIMEOUT_MS = 840_000;
export const HEARTBEAT_FRESH_MS = 120_000;
export const HEARTBEAT_BUSY_GRACE_MS = 900_000;

const MAX_JOBS = 20;
const JOB_TTL_MS = 24 * 60 * 60_000;
const VALID_STATUS = new Set(['running', 'completed', 'failed']);

const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** 读取持久化的 job 表；任何损坏都退化为空表，不让桥接启动失败。 */
export function loadBrowseJobs(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.jobs : null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const jobs = {};
    for (const [id, job] of Object.entries(source)) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
      jobs[id] = {
        jobId: id,
        status: VALID_STATUS.has(job.status) ? job.status : 'failed',
        startedAt: Number(job.startedAt) || 0,
        minutes: Number(job.minutes) || 0,
        result: bounded(job.result, 24_000),
        error: bounded(job.error, 4_000)
      };
    }
    return jobs;
  } catch { return {}; }
}

/** 原子写入 job 表；只保留最近 24 小时内、最多 20 条。接受 Map 或普通对象。 */
export function saveBrowseJobs(path, jobs, now = Date.now()) {
  const entries = [...(jobs instanceof Map ? jobs.values() : Object.values(jobs || {}))]
    .filter((job) => job && job.jobId && now - (Number(job.startedAt) || 0) <= JOB_TTL_MS)
    .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))
    .slice(0, MAX_JOBS)
    .map((job) => [job.jobId, {
      jobId: job.jobId,
      status: VALID_STATUS.has(job.status) ? job.status : 'failed',
      startedAt: Number(job.startedAt) || 0,
      minutes: Number(job.minutes) || 0,
      result: bounded(job.result, 24_000),
      error: bounded(job.error, 4_000)
    }]);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, jobs: Object.fromEntries(entries) }));
  renameSync(temporary, path);
}

/** 对外可见的 job 状态；running 超过 timeoutMs 直接判为失败终态。 */
export function jobView(job, now = Date.now(), { timeoutMs = BROWSE_JOB_TIMEOUT_MS } = {}) {
  if (!job) return null;
  if (job.status === 'running' && now - (Number(job.startedAt) || 0) > timeoutMs) {
    return {
      jobId: job.jobId,
      status: 'failed',
      ok: false,
      result: '',
      error: '抖音浏览超时：超过 14 分钟没有拿到结果，按失败处理。'
    };
  }
  if (job.status === 'running') return { ok: true, status: 'running', jobId: job.jobId };
  return {
    ok: job.status === 'completed',
    status: job.status,
    jobId: job.jobId,
    result: job.result || '',
    error: job.error || ''
  };
}

/** 把超时的 running 落成 failed，保证同一 job 只给一次失败结论。 */
export function settleExpiredJobs(jobs, now = Date.now(), options) {
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (!job || job.status !== 'running') continue;
    const view = jobView(job, now, options);
    if (view.status === 'failed') {
      job.status = 'failed';
      job.result = '';
      job.error = view.error;
      changed = true;
    }
  }
  return changed;
}

/**
 * 监听器心跳判定。
 * at 为毫秒时间戳；busy 表示监听器正在执行浏览（可能长时间不写新心跳）。
 * 没有心跳文件时返回 online:null，调用方应保留旧行为，不误拦。
 */
export function evaluateListenerHeartbeat(raw, now = Date.now(), {
  freshMs = HEARTBEAT_FRESH_MS,
  busyGraceMs = HEARTBEAT_BUSY_GRACE_MS
} = {}) {
  const at = Number(raw?.at) || 0;
  if (!at) return { online: null, busy: false, ageMs: null, reason: 'missing' };
  const busy = raw?.busy === true;
  const ageMs = Math.max(0, now - at);
  const limit = busy ? busyGraceMs : freshMs;
  if (ageMs > limit) return { online: false, busy, ageMs, reason: busy ? 'stale-busy' : 'stale' };
  return { online: true, busy, ageMs, reason: '' };
}

/** 读心跳文件；文件缺失或损坏按 online:null 处理（兼容尚未写入心跳的旧监听器）。 */
export function readListenerHeartbeat(path, now = Date.now(), options) {
  try {
    return evaluateListenerHeartbeat(JSON.parse(readFileSync(path, 'utf8')), now, options);
  } catch {
    return { online: null, busy: false, ageMs: null, reason: 'missing' };
  }
}
