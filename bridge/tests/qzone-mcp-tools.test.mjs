import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Qzone tools are available to the model and reject a caller without an owner session', async () => {
  const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  const client = new Client({ name: 'qzone-tool-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of ['qq_post_qzone', 'qq_list_my_qzone', 'qq_qzone_detail', 'qq_comment_qzone']) {
      assert.ok(names.has(name), `${name} missing`);
    }
    const denied = await client.callTool({
      name: 'qq_post_qzone',
      arguments: { key: 'private:00000', token: 'invalid', content: '这是一条绝不能发送的测试动态。' }
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
});
