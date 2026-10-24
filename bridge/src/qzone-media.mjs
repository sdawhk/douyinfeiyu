const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stopWords = new Set([
  '今天', '昨天', '刚刚', '最近', '主人', '群友', '大家', '一个', '这个', '那个', '然后',
  '结果', '突然', '感觉', '觉得', '真的', '有点', '还是', '因为', '所以', '但是', '自己',
  '我们', '你们', '他们', '就是', '不是', '没有', '可以', '一下', '什么', '怎么', '小鲸鱼',
  '机器人', '动态', '图片', '表情包'
]);

function terms(value) {
  const text = String(value ?? '').toLocaleLowerCase('zh-CN');
  const result = new Set();
  for (const part of segmenter.segment(text)) {
    const word = part.segment.trim();
    if (part.isWordLike && [...word].length > 1 && !stopWords.has(word)) result.add(word);
  }
  const compact = text.replace(/[^\p{L}\p{N}]/gu, '');
  const chars = [...compact];
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    if (!stopWords.has(pair)) result.add(pair);
  }
  return result;
}

/** Pick one safe image whose description overlaps the post topic; never reuse a recent ref. */
export function selectRelatedQzoneMedia(text, candidates, recentRefs = []) {
  const topic = terms(text);
  if (topic.size < 2 || !Array.isArray(candidates)) return null;
  const recent = new Set(recentRefs.map(String));
  const ranked = candidates.flatMap((candidate) => {
    if (!candidate?.ref || !candidate?.path || recent.has(String(candidate.ref)) || candidate.safe !== true) return [];
    const description = terms(candidate.description);
    let overlap = 0;
    for (const term of topic) if (description.has(term)) overlap++;
    const score = overlap / Math.max(1, Math.min(topic.size, description.size));
    return overlap >= 2 && score >= 0.12 ? [{ candidate, overlap, score }] : [];
  });
  ranked.sort((a, b) => b.score - a.score || b.overlap - a.overlap || String(a.candidate.ref).localeCompare(String(b.candidate.ref)));
  return ranked[0]?.candidate ?? null;
}
