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
    // videoUrl 与 videoTitle 二选一、由运行时校验互斥，两者都不能进 required，
    // 否则会堵死按标题点赞/评论这条路。required 只保留每次都必填的四个字段。
    assert.deepEqual(new Set(douyinInteract.inputSchema.required), new Set(['key', 'token', 'action', 'dryRun']));
    assert.ok(douyinInteract.inputSchema.properties?.videoUrl, 'videoUrl 应作为可选参数暴露');
    assert.ok(douyinInteract.inputSchema.properties?.videoTitle, 'videoTitle 应作为可选参数暴露');
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

    // 两段式安全闸：confirm 只能是可选参数，真正上传仍由 confirm 决定，不能被改成必填。
    assert.ok(avatarTool.inputSchema.properties?.confirm, 'confirm 参数必须存在');
    assert.ok(avatarTool.inputSchema.properties?.dryRun, 'dryRun 参数必须存在');
    assert.equal(new Set(avatarTool.inputSchema.required).has('confirm'), false, 'confirm 不能变成必填');
    assert.match(mcpSource, /dryRun \|\| \(options\.requireConfirm && !confirm\)/);
  } finally {
    await client.close();
  }
});

test('avatar prompt accepts casual approval but keeps two-stage confirm', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/qq-bot.mjs', import.meta.url)), 'utf8');
  assert.match(source, /【机器人本人头像】/);
  assert.match(source, /换吧\/再换一次\/试试\/给你加权限了\/换成这张/);
  assert.match(source, /先不带 confirm（或 dryRun=true）预览/);
  assert.match(source, /再传 confirm=true/);
  assert.match(source, /群聊里绝不能调用/);
  assert.match(source, /ownerTurn && !key\.startsWith\('g'\)/);
});
