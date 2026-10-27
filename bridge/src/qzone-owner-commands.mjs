export function resolveOwnQzoneComment(post, path, selfId) {
  if (!post?.tid || !Array.isArray(post.comments) || !/^\d{5,20}$/.test(String(selfId ?? ''))) return null;
  const indexes = String(path).split('.').map(Number);
  if (!indexes.length || indexes.some((n) => !Number.isInteger(n) || n < 1)) return null;
  let node = null;
  let siblings = post.comments;
  for (const index of indexes) {
    node = siblings?.[index - 1];
    siblings = node?.replies;
  }
  const commentId = String(node?.comment_id ?? '');
  const userId = String(node?.uin ?? '');
  if (!node || !/^\d{1,20}$/.test(commentId) || !/^\d{5,20}$/.test(userId)) return null;
  return { tid: String(post.tid), commentId, userId, selfId: String(selfId) };
}

export function qzonePostOffset(index) {
  const value = Number(index);
  return Number.isInteger(value) && value >= 1 && value <= 110 ? value - 1 : null;
}
