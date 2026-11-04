// Model-facing sticker directives are never plain QQ text.
// Accept the current [sticker:key] protocol and legacy [DeepSeek娘123] / [table:123] markers;
// strip malformed directives at text sinks so they never leak into QQ messages.
export const STICKER_TOKEN_RE = /[\[［【]\s*(?:sticker\s*[:：]\s*([^\]］】\r\n]{1,80}?)|table\s*[:：]\s*(\d{3,4})|(?=DeepSeek娘\s*\d{3,4}\s*[\]］】])(DeepSeek娘\s*\d{3,4}))\s*[\]］】]/gi;
const STICKER_DIRECTIVE_RE = /[\[［【]\s*(?:sticker\b|table\s*[:：])[^\]］】\r\n]*[\]］】]?|[\[［【]\s*DeepSeek娘\s*\d{3,4}\s*[\]］】]?/gi;
const STICKER_STATUS_RE = /[\[［【]\s*sticker\s*[\]］】]\s*sent\b/gi;

export function stickerTokens(value) {
  return [...String(value ?? '').matchAll(STICKER_TOKEN_RE)].map((match) => {
    match[1] = match[1] ?? (match[2] ? `DeepSeek娘${match[2]}` : match[3].replace(/\s+/g, ''));
    return match;
  });
}

export function hasStickerDirective(value) {
  return /[\[［【]\s*(?:sticker\b|table\s*[:：])|[\[［【]\s*DeepSeek娘\s*\d{3,4}/i.test(String(value ?? ''));
}

export function stripStickerDirectives(value) {
  return String(value ?? '').replace(STICKER_STATUS_RE, '').replace(STICKER_DIRECTIVE_RE, '')
    .replace(/[ \t]{2,}/g, ' ').trim();
}
