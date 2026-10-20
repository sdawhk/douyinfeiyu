import assert from 'node:assert/strict';
import { parseBingResults, parseDuckDuckGoResults, searchWeb } from '../src/web-search-engine.mjs';

const bing = parseBingResults(
  '<li class="b_algo extra"><h2><a href="https://example.com/a">Example &amp; title</a></h2><p>Short <b>summary</b>.</p></li>',
  'test'
);
assert.equal(bing.results.length, 1);
assert.equal(bing.results[0].title, 'Example & title');
assert.equal(bing.results[0].url, 'https://example.com/a');
assert.equal(bing.results[0].snippet, 'Short summary.');

const tenBing = parseBingResults(
  `<html>${Array.from({ length: 12 }, (_, i) => `<li class="b_algo"><h2><a href="https://example.com/${i}">Result ${i}</a></h2></li>`).join('')}</html>`,
  'ten results'
);
assert.equal(tenBing.results.length, 10);

const ddg = parseDuckDuckGoResults(
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example page</a><div class="result__snippet">A <b>short</b> summary.</div>',
  'test'
);
assert.equal(ddg.results.length, 1);
assert.equal(ddg.results[0].url, 'https://example.com/page');
assert.equal(ddg.results[0].snippet, 'A short summary.');

let calls = 0;
const fallback = await searchWeb(' test query ', async () => {
  calls += 1;
  if (calls === 1) return new Response('<html>changed markup</html>', { status: 200 });
  return new Response(
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=abc">Fallback result</a>',
    { status: 200 }
  );
});
assert.equal(calls, 2);
assert.equal(fallback.results[0].source, 'DuckDuckGo');
assert.deepEqual(fallback.providersTried, ['Bing', 'DuckDuckGo']);
assert.ok(Number.isFinite(Date.parse(fallback.retrievedAt)));

const empty = await searchWeb('no results', async () => new Response('<html>no result markup</html>', { status: 200 }));
assert.deepEqual(empty.providersTried, ['Bing', 'DuckDuckGo']);
assert.equal(empty.results.length, 0);
assert.match(empty.warning, /未解析出搜索结果/);
assert.ok(Number.isFinite(Date.parse(empty.retrievedAt)));

console.log('web search parser and fallback tests passed');
