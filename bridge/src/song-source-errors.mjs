// 用错误类型区分音源无歌声、下载失败和分离程序失败，避免同一坏源反复重做。
export const NO_AUDIBLE_VOCALS = 'NO_AUDIBLE_VOCALS';
export const STEM_SEPARATION_FAILED = 'STEM_SEPARATION_FAILED';
export const SONG_SOURCE_UNAVAILABLE = 'SONG_SOURCE_UNAVAILABLE';

export function songSourceError(code, message, details = {}) {
  return Object.assign(new Error(message, details.cause ? { cause: details.cause } : undefined), { code, ...details });
}

export function canRetrySongSource(error) {
  return [NO_AUDIBLE_VOCALS, SONG_SOURCE_UNAVAILABLE].includes(error?.code);
}
