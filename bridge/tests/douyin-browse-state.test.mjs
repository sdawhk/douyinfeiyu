import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BROWSE_JOB_TIMEOUT_MS,
  evaluateListenerHeartbeat,
  jobView,
  loadBrowseJobs,
  saveBrowseJobs,
  settleExpiredJobs
} from '../src/douyin-browse-state.mjs';

const JOB_ID = '11111111-2222-3333-4444-555555555555';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-browse-state-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a running job older than the timeout becomes a single failed conclusion', () => {
  const now = Date.now();
  const job = { jobId: JOB_ID, status: 'running', startedAt: now - BROWSE_JOB_TIMEOUT_MS - 1 };
  assert.equal(jobView(job, now).status, 'failed');
  const jobs = { [JOB_ID]: job };
  assert.equal(settleExpiredJobs(jobs, now), true);
  assert.equal(jobs[JOB_ID].status, 'failed');
  // 已经是终态，不会再次改写或重复给结论。
  assert.equal(settleExpiredJobs(jobs, now), false);
  assert.equal(jobView(jobs[JOB_ID], now).status, 'failed');
});

test('fresh running and completed jobs keep their status', () => {
  const now = Date.now();
  assert.equal(jobView({ jobId: JOB_ID, status: 'running', startedAt: now - 1000 }, now).status, 'running');
  const done = jobView({ jobId: JOB_ID, status: 'completed', startedAt: now - 1000, result: '三条视频' }, now);
  assert.equal(done.status, 'completed');
  assert.equal(done.ok, true);
  assert.equal(done.result, '三条视频');
});

test('jobs survive a bridge restart because they are written to disk', () => {
  withTempDir((dir) => {
    const path = join(dir, 'jobs.json');
    saveBrowseJobs(path, {
      [JOB_ID]: { jobId: JOB_ID, status: 'completed', startedAt: Date.now(), minutes: 1, result: 'ok' }
    });
    assert.deepEqual(Object.keys(loadBrowseJobs(path)), [JOB_ID]);
    assert.equal(loadBrowseJobs(path)[JOB_ID].status, 'completed');
  });
});

test('saveBrowseJobs accepts the in-memory Map used by the bridge', () => {
  withTempDir((dir) => {
    const path = join(dir, 'jobs.json');
    const live = new Map([[JOB_ID, { jobId: JOB_ID, status: 'running', startedAt: Date.now(), minutes: 2 }]]);
    saveBrowseJobs(path, live);
    assert.deepEqual(Object.keys(loadBrowseJobs(path)), [JOB_ID]);
    assert.equal(loadBrowseJobs(path)[JOB_ID].status, 'running');
  });
});

test('corrupt or missing job state degrades to an empty table instead of crashing', () => {
  withTempDir((dir) => {
    const path = join(dir, 'jobs.json');
    writeFileSync(path, 'not json');
    assert.deepEqual(loadBrowseJobs(path), {});
    assert.deepEqual(loadBrowseJobs(join(dir, 'missing.json')), {});
  });
});

test('heartbeat: missing file is unknown, fresh is online, stale idle is offline, stale busy is still online', () => {
  const now = Date.now();
  assert.deepEqual(evaluateListenerHeartbeat(null, now), { online: null, busy: false, ageMs: null, reason: 'missing' });
  assert.equal(evaluateListenerHeartbeat({ at: now - 10_000, busy: false }, now).online, true);
  assert.equal(evaluateListenerHeartbeat({ at: now - 10_000, busy: true }, now).online, true);
  assert.equal(evaluateListenerHeartbeat({ at: now - 130_000, busy: false }, now).online, false);
  assert.equal(evaluateListenerHeartbeat({ at: now - 130_000, busy: true }, now).online, true);
  assert.equal(evaluateListenerHeartbeat({ at: now - 901_000, busy: true }, now).online, false);
});
