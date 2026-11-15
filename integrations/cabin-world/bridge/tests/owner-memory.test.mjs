import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOwnerMemory } from '../lib/owner-memory.mjs';

async function withFile(contents, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owner-memory-'));
  const file = path.join(dir, 'memory.json');
  try {
    if (contents !== undefined) await fsp.writeFile(file, contents, 'utf8');
    await fn(file);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

test('returns only valid v2 entries and maps report and entries', async () => {
  const fixture = {
    schemaVersion: 2,
    identityFacts: [{ text: 'stable', confidence: 'confirmed' }, { text: 'weak', confidence: 0.2 }],
    facts: ['plain', { content: 'corrected out', status: 'corrected' }, { text: 'old', expiresAt: 1 }, { text: 'uncertain', confidence: 0.5 }],
    events: [{ summary: 'kept event', occurredAt: '2026-11-01' }],
    corrections: [{ fact: 'new truth', confidence: 0.9 }],
    standingPermissions: ['never include'], groups: ['never include'], sessions: ['never include'],
  };
  await withFile(JSON.stringify(fixture), async file => {
    const result = await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu', 100);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.entries.map(row => row.text), ['stable', 'plain', 'kept event', 'new truth']);
    assert.deepEqual(result.data.entries.map(row => row.category), ['identity', 'fact', 'event', 'correction']);
    assert.equal(result.data.entries[2].at, '2026-11-01');
    assert.equal(result.data.report.events, 1);
    assert.deepEqual(result.data.report.knowledge, { hot: 2, warm: 0, cold: 0, pending: 0, superseded: 0 });
    assert.deepEqual(result.data.report.anchors, { confirmed: [], proposals: [] });
    assert.deepEqual(result.data.report.commitments, { open: 0, fulfilled: 0, broken: 0 });
    assert.deepEqual(result.data.report.metrics, { coldQueries: 0 });
    assert.equal(JSON.stringify(result).includes('never include'), false);
  });
});

test('only xiaojingyu can read', async () => {
  await withFile('{"schemaVersion":2,"facts":["private"]}', async file => {
    for (const [who, key] of [['someone', 'xiaojingyu'], ['xiaojingyu', 'other']]) {
      const result = await readOwnerMemory(file, who, key);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'resident_not_authorized');
      assert.deepEqual(result.data.entries, []);
    }
  });
});

test('missing, corrupt, and unsupported schema are safe actionable errors', async () => {
  await withFile(undefined, async file => {
    assert.equal((await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu')).error, 'memory_source_missing');
  });
  await withFile('{broken', async file => {
    const result = await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu');
    assert.equal(result.error, 'memory_source_unavailable');
    assert.equal(JSON.stringify(result).includes(file), false);
  });
  await withFile('{"schemaVersion":1}', async file => {
    assert.equal((await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu')).error, 'memory_schema_invalid');
  });
});

test('per-category limits and text length are enforced', async () => {
  const fixture = { schemaVersion: 2, identityFacts: Array(10).fill('i'), facts: Array(12).fill('f'), events: Array(8).fill('e'), corrections: Array(7).fill('c') };
  await withFile(JSON.stringify(fixture), async file => {
    const result = await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu');
    assert.deepEqual(result.data.report.anchors.confirmed, []);
    assert.equal(result.data.entries.length, 24);
    assert.equal(result.data.entries.every(row => row.text.length <= 240), true);
    assert.equal((await readOwnerMemory(file, 'xiaojingyu', 'xiaojingyu')).data.report.events, 5);
  });
});
