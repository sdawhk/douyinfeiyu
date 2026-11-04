import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Qzone tools are available to the model and reject a caller without an owner session', async () => {
  const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));
  const mcpSource = readFileSync(entry, 'utf8');
  assert.match(mcpSource, /http:\/\/127\.0\.0\.1:3101\/douyin\/share-latest/);
  assert.match(mcpSource, /http:\/\/127\.0\.0\.1:3101\/douyin\/interact/);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  const client = new Client({ name: 'qzone-tool-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of ['qq_post_qzone', 'qq_list_my_qzone', 'qq_qzone_detail', 'qq_comment_qzone']) {
      assert.ok(names.has(name), `${name} missing`);
    }
    const douyinShare = tools.tools.find((tool) => tool.name === 'douyin_share_latest_watched_video');
    assert.ok(douyinShare, 'Douyin share tool missing');
    assert.deepEqual(new Set(douyinShare.inputSchema.required), new Set(['key', 'token']));
    const deniedDouyinShare = await client.callTool({
      name: 'douyin_share_latest_watched_video',
      arguments: { key: 'group:839367702', token: 'invalid' }
    });
    assert.equal(deniedDouyinShare.isError, true);
    const douyinBrowse = tools.tools.find((tool) => tool.name === 'douyin_browse_recommendations');
    assert.ok(douyinBrowse, 'Douyin browse tool missing');
    assert.deepEqual(new Set(douyinBrowse.inputSchema.required), new Set(['key', 'token', 'minutes']));
    const deniedDouyinBrowse = await client.callTool({
      name: 'douyin_browse_recommendations',
      arguments: { key: 'group:839367702', token: 'invalid', minutes: 1 }
    });
    assert.equal(deniedDouyinBrowse.isError, true);
    const douyinInteract = tools.tools.find((tool) => tool.name === 'douyin_interact_with_video');
    assert.ok(douyinInteract, 'Douyin interaction tool missing');
    assert.deepEqual(new Set(douyinInteract.inputSchema.required), new Set(['key', 'token', 'action', 'videoUrl', 'dryRun']));
    const deniedDouyinInteract = await client.callTool({
      name: 'douyin_interact_with_video',
      arguments: {
        key: 'group:839367702', token: 'invalid', action: 'like',
        videoUrl: 'https://www.douyin.com/video/123', dryRun: true
      }
    });
    assert.equal(deniedDouyinInteract.isError, true);
    const statusTool = tools.tools.find((tool) => tool.name === 'qq_status');
    assert.ok(statusTool, 'qq_status missing');
    assert.deepEqual(new Set(statusTool.inputSchema.required), new Set(['key', 'token']));
    const deniedStatus = await client.callTool({
      name: 'qq_status',
      arguments: { key: 'group:839367702', token: 'invalid' }
    });
    assert.equal(deniedStatus.isError, true);
    const denied = await client.callTool({
      name: 'qq_post_qzone',
      arguments: { key: 'private:00000', token: 'invalid', content: '这是一条绝不能发送的测试动态。' }
    });
    assert.equal(denied.isError, true);

    // 个人头像：只注册工具 + 校验权限，群聊/非主人必须在上传前被拒绝（不会触达 OneBot）。
    const avatarTool = tools.tools.find((tool) => tool.name === 'qq_set_my_avatar');
    assert.ok(avatarTool, 'qq_set_my_avatar missing');
    assert.deepEqual(new Set(avatarTool.inputSchema.required), new Set(['key', 'token', 'sourceType']));
    const deniedAvatarGroup = await client.callTool({
      name: 'qq_set_my_avatar',
      arguments: { key: 'group:839367702', token: 'invalid', sourceType: 'self' }
    });
    assert.equal(deniedAvatarGroup.isError, true);
    assert.match(deniedAvatarGroup.content?.[0]?.text ?? '', /仅允许主人私聊/);
    const deniedAvatarStranger = await client.callTool({
      name: 'qq_set_my_avatar',
      arguments: { key: 'private:999999', token: 'invalid', sourceType: 'self' }
    });
    assert.equal(deniedAvatarStranger.isError, true);
  } finally {
    await client.close();
  }
});
