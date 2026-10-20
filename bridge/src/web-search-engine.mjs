const SEARCH_TIMEOUT_MS = 8_000;
const MAX_SEARCH_RESULTS = 10;

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?，。！？；：])/g, '$1')
    .trim();
}

function cleanResult(title, url, snippet, source) {
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return { title, url, snippet, source };
}

export function parseBingResults(html, query) {
  const blocks = String(html ?? '').split(/<li\b(?=[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'])[^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/i);
    const titleMatch = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (!hrefMatch || !titleMatch) continue;
    const snippetMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const result = cleanResult(
      decodeHtml(titleMatch[1]),
      decodeHtml(hrefMatch[1]),
      decodeHtml(snippetMatch?.[1] ?? ''),
      'Bing'
    );
    if (result) results.push(result);
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return { query, results };
}

export function parseDuckDuckGoResults(html, query) {
  const source = String(html ?? '');
  const anchors = [...source.matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const results = [];
  for (let i = 0; i < anchors.length && results.length < MAX_SEARCH_RESULTS; i++) {
    const match = anchors[i];
    let url;
    try {
      const link = new URL(decodeHtml(match[1]), 'https://duckduckgo.com');
      if (link.hostname === 'duckduckgo.com' && link.pathname === '/l/') {
        url = link.searchParams.get('uddg') ?? '';
      } else {
        url = link.toString();
      }
    } catch {
      continue;
    }
    const start = match.index + match[0].length;
    const end = anchors[i + 1]?.index ?? source.length;
    const snippetMatch = source.slice(start, end).match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)(?:<\/div>|<\/a>)/i);
    const result = cleanResult(decodeHtml(match[2]), url, decodeHtml(snippetMatch?.[1] ?? ''), 'DuckDuckGo');
    if (result) results.push(result);
  }
  return { query, results };
}

async function readSearchResponse(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_000_000) {
      await reader.cancel();
      throw new Error('搜索页面超过 1 MB，已停止读取');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchSearchHtml(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  return readSearchResponse(response);
}

export async function searchWeb(query, fetchImpl = fetch) {
  const clean = String(query ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!clean) throw new Error('查询词为空，已拒绝。');

  const attempts = [
    {
      source: 'Bing',
      url: () => {
        const url = new URL('https://cn.bing.com/search');
        url.searchParams.set('q', clean);
        return url;
      },
      parse: parseBingResults,
    },
    {
      source: 'DuckDuckGo',
      url: () => {
        const url = new URL('https://html.duckduckgo.com/html/');
        url.searchParams.set('q', clean);
        return url;
      },
      parse: parseDuckDuckGoResults,
    },
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      const html = await fetchSearchHtml(attempt.url(), fetchImpl);
      const result = attempt.parse(html, clean);
      if (result.results.length) {
        return {
          ...result,
          providersTried: failures.map((item) => item.source).concat(attempt.source),
          retrievedAt: new Date().toISOString(),
        };
      }
      failures.push({ source: attempt.source, error: '页面未解析出搜索结果' });
    } catch (error) {
      failures.push({ source: attempt.source, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return {
    query: clean,
    results: [],
    providersTried: failures.map((item) => item.source),
    retrievedAt: new Date().toISOString(),
    warning: failures.map((item) => `${item.source}: ${item.error}`).join('；'),
  };
}
