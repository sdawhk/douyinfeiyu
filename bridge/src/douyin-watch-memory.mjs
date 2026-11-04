const canonicalDouyinVideo = (value) => {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:'
      && ['www.douyin.com', 'douyin.com'].includes(url.hostname)
      && /^\/video\/\d+$/.test(url.pathname)
      ? `https://www.douyin.com${url.pathname}`
      : '';
  } catch {
    return '';
  }
};

const normalizeTitle = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** Resolve only a unique, recently watched video from the local watch memory. */
export function resolveWatchedVideo(memory, requestedTitle, { now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const query = normalizeTitle(requestedTitle);
  if ([...query].length < 2) throw new Error('视频标题太短，无法安全定位；请使用更完整的标题');

  const videos = Array.isArray(memory?.watchedVideos) ? memory.watchedVideos.slice(-30) : [];
  const eligible = videos.flatMap((video) => {
    const url = canonicalDouyinVideo(video?.url);
    const title = normalizeTitle(video?.title);
    const observedAt = Date.parse(video?.observedAt ?? '');
    if (!url || !title || !Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) return [];
    return [{ ...video, url, normalizedTitle: title }];
  });

  let matches = eligible.filter((video) => video.normalizedTitle === query);
  if (matches.length === 0) matches = eligible.filter((video) => video.normalizedTitle.includes(query));
  const distinct = [...new Map(matches.map((video) => [video.url, video])).values()];
  if (distinct.length === 0) throw new Error('最近观看记录中没有匹配的视频；未执行互动');
  if (distinct.length !== 1) throw new Error('标题匹配到多条最近观看视频；请提供更完整标题，未执行互动');
  const { normalizedTitle, ...video } = distinct[0];
  return video;
}
