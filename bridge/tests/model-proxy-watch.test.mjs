import test from 'node:test';
import assert from 'node:assert/strict';

const { createModelProxyWatch } = await import('../src/model-proxy-watch.mjs');

const entries = [
  { port: 18901, script: 'a.mjs', logFile: 'a.log' },
  { port: 18903, script: 'b.mjs', logFile: 'b.log' }
];

function harness(initialAlive, { reviveOnStart = false } = {}) {
  const alive = new Map(Object.entries(initialAlive).map(([port, value]) => [String(port), value]));
  const started = [];
  const notices = [];
  let clock = 1_000_000;
  const watch = createModelProxyWatch({
    entries,
    probe: async (port) => Boolean(alive.get(String(port))),
    start: async (entry) => {
      started.push(entry.port);
      if (reviveOnStart) alive.set(String(entry.port), true);
    },
    notify: async (text) => { notices.push(text); },
    log: () => {},
    sleep: async () => {},
    now: () => clock
  });
  return {
    watch,
    started,
    notices,
    setAlive: (port, value) => alive.set(String(port), value),
    advance: (ms) => { clock += ms; }
  };
}

test('dead proxies are restarted and no notice is sent when self-heal works', async () => {
  const h = harness({ 18901: false, 18903: false }, { reviveOnStart: true });
  await h.watch.tick();
  assert.deepEqual(h.started, [18901, 18903]);
  assert.deepEqual(h.notices, []);
});

test('a proxy that stays down is reported once and not repeated inside the cooldown', async () => {
  const h = harness({ 18901: false, 18903: true });
  await h.watch.tick();
  assert.deepEqual(h.started, [18901]);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /脑子那边断了/);

  await h.watch.tick();
  assert.deepEqual(h.started, [18901], 'restart should be throttled');
  assert.equal(h.notices.length, 1, 'notice should be deduplicated');

  h.advance(16 * 60_000);
  await h.watch.tick();
  assert.deepEqual(h.started, [18901, 18901], 'restart retried after cooldown');
  assert.equal(h.notices.length, 2, 'notice repeated after cooldown');
});

test('recovery sends one closing line and clears the notice state', async () => {
  const h = harness({ 18901: false, 18903: false });
  await h.watch.tick();
  assert.equal(h.notices.length, 1);

  h.setAlive(18901, true);
  h.setAlive(18903, true);
  h.advance(60_000);
  await h.watch.tick();
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[1], /脑子接回来了/);

  h.advance(60_000);
  await h.watch.tick();
  assert.equal(h.notices.length, 2, 'recovery line is sent only once');
});

test('healthy proxies produce no restart and no notice', async () => {
  const h = harness({ 18901: true, 18903: true });
  await h.watch.tick();
  assert.deepEqual(h.started, []);
  assert.deepEqual(h.notices, []);
});
