export function plainQzoneText(value, maxLength = 800) {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/p\s*>|<\/div\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\\x([\da-f]{2})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\u([\da-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\\//g, '/')
    .replace(/[\u0000-\u001f\s]+/g, ' ')
    .trim().slice(0, maxLength);
}

/** Match a full local post against Qzone's 120-character list preview or its exact tid. */
export function qzonePostMatchesText(post, text, tid = '') {
  if (tid && String(post?.tid ?? post?.key ?? '') === String(tid)) return true;
  const actual = plainQzoneText(post?.content ?? post?.text ?? post?.con ?? post?.summary);
  const expected = plainQzoneText(text);
  if (actual && actual === expected) return true;
  if (!/…$/.test(actual)) return false;
  const preview = actual.replace(/…+$/, '');
  return [...preview].length >= 60 && expected.startsWith(preview);
}

export function qzoneFeedKey(feed) {
  const owner = String(feed?.uin ?? '');
  const tid = String(feed?.key ?? feed?.tid ?? '');
  const time = Number(feed?.time) || 0;
  return /^\d{5,20}$/.test(owner) && tid ? `${owner}:${tid}:${time}` : '';
}

export function qzoneCommentKey(postTid, comment) {
  const commentId = String(comment?.comment_id ?? '');
  const userId = String(comment?.uin ?? '');
  if (!postTid || !commentId || !/^\d{5,20}$/.test(userId)) return '';
  return `${postTid}:${commentId}:${userId}`;
}

export function qzonePostsWithComments(result) {
  if (!Array.isArray(result?.msglist)) throw new Error('QQ 空间说说列表不可用');
  if (result.msglist.some((post) => !Array.isArray(post.comments))) {
    throw new Error('SnowLuma 当前返回的说说没有 comments 字段，请重启 SnowLuma 以加载评论读取实现');
  }
  return result.msglist;
}
