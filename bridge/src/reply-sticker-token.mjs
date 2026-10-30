// Model-facing sticker directives are never plain QQ text.
// Accept case, spacing and colon variants; strip malformed directives at text sinks.
export const STICKER_TOKEN_RE = /[\[［【]\s*sticker\s*[:：]\s*([^\]］】\r\n]{1,80}?)\s*[\]］】]/gi;
const STICKER_DIRECTIVE_RE = /[\[［【]\s*sticker\b[^\]］】\r\n]*[\]］】]?/gi;
const STICKER_STATUS_RE = /[\[［【]\s*sticker\s*[\]］】]\s*sent\b/gi;

export function stickerTokens(value) {
  return [...String(value ?? '').matchAll(STICKER_TOKEN_RE)];
}

export function hasStickerDirective(value) {
  return /[\[［【]\s*sticker\b/i.test(String(value ?? ''));
}

export function stripStickerDirectives(value) {
  return String(value ?? '').replace(STICKER_STATUS_RE, '').replace(STICKER_DIRECTIVE_RE, '')
    .replace(/[ \t]{2,}/g, ' ').trim();
}
