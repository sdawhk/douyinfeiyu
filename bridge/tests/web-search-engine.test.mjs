import test from 'node:test';
import assert from 'node:assert/strict';
import { needsFreshSearch, parseBingRssResults, searchWeb } from '../src/web-search-engine.mjs';

test('Bing RSS keeps titles, links, and summaries', () => {
  const xml = '<?xml version="1.0"?><rss><channel><item><title>雨爱（司凤版） &amp; 来源</title>'
    + '<link>https://example.com/song?a=1&amp;b=2</link><description>网络热梗 &amp; 翻唱</description></item></channel></rss>';
  assert.deepEqual(parseBingRssResults(xml, '雨爱').results, [{
    title: '雨爱（司凤版） & 来源', url: 'https://example.com/song?a=1&b=2',
    snippet: '网络热梗 & 翻唱', source: 'Bing RSS'
  }]);
});

test('search uses Bing RSS and falls back when it has no results', async () => {
  const urls = [];
  const fetched = await searchWeb('雨爱 司凤版 是什么梗', async (url, options) => {
    urls.push(String(url));
    assert.match(options.headers['user-agent'], /Chrome\/\d+/);
    return new Response(url.searchParams.get('format') === 'rss'
      ? '<rss><channel></channel></rss>'
      : '<li class="b_algo"><h2><a href="https://example.com/meme">司凤版是什么梗</a></h2><p>相关解释</p></li>');
  });
  assert.deepEqual(fetched.providersTried, ['Bing RSS', 'Bing']);
  assert.equal(fetched.results[0].title, '司凤版是什么梗');
  assert.equal(urls.length, 2);
});

test('explicit meme questions trigger fresh search without treating every joke as a search', () => {
  assert.equal(needsFreshSearch('雨爱司凤版是什么梗'), true);
  assert.equal(needsFreshSearch('这个梗是什么意思'), true);
  assert.equal(needsFreshSearch('最近有什么网络热梗'), true);
  assert.equal(needsFreshSearch('今天有什么新闻'), true);
  assert.equal(needsFreshSearch('你接梗接得挺好'), false);
  assert.equal(needsFreshSearch('唱雨爱司凤版'), false);
});
