// 测试安全 Web Search / Fetch MCP server：
// - web_search：查一个网络用语/梗
// - web_fetch：抓取一个公开 URL 并检查是否返回正文
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  const searchText = search.content?.[0]?.text ?? '';
  const searchData = JSON.parse(searchText);
  if (search.isError || !Array.isArray(searchData.results) || searchData.results.length === 0) {
    throw new Error(`web_search returned no results: ${searchText.slice(0, 200)}`);
  }
  console.log(`✅ web_search: ${searchData.results.length} results via ${searchData.providersTried.join(' → ')}`);

  const fetch = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://www.deepseek.com/' }
  });
  const fetchText = fetch.content?.[0]?.text ?? '';
  const fetchData = JSON.parse(fetchText);
  if (fetch.isError || fetchData.statusCode !== 200 || typeof fetchData.body !== 'string' || !fetchData.body.length) {
    throw new Error(`web_fetch failed: ${fetchText.slice(0, 200)}`);
  }
  console.log(`✅ web_fetch: HTTP ${fetchData.statusCode}, ${fetchData.body.length} chars`);

  // 内网地址应被拒绝
  const bad = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  console.log('🚫 内网拦截:', bad.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', bad.content?.[0]?.text?.slice(0, 120));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
