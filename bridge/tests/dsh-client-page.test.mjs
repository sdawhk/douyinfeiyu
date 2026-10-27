import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeApiClient } from '../src/dsh-client-020.js';

test('session page wraps the request at the DSH 0.2 RPC boundary', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ result: { value: { records: [], hasMore: false } } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const client = new NodeApiClient('http://127.0.0.1:3090');
    const request = {
      address: { kind: 'session', sessionId: 'session-test' },
      throughSeq: 7,
      maxMessages: 200,
      turnWindow: { minMessages: 2, minTurns: 1 }
    };
    await client.sessions.page(request);
    assert.equal(requestBody.method, 'session/page');
    assert.deepEqual(requestBody.payload.args, { request });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
