import { shouldBlockImageStorage } from './image-content-policy.mjs';

export const IMAGE_LIBRARY_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const PAYMENT_IMAGE = /(?:支付|付款|收款|转账|交易|银行卡).{0,8}(?:截图|凭证|二维码|收款码|付款码|账单|记录)|(?:截图|凭证|二维码|收款码|付款码|账单|记录).{0,8}(?:支付|付款|收款|转账|交易|银行卡)|支付宝|微信支付/i;
const CHAT_SCREENSHOT = /聊天截图|聊天记录截图|对话截图|私聊截图|群聊截图|聊天记录图片/i;

/** Only act on a confident visual classification of a payment image or chat screenshot. */
export function shouldCleanImageArchiveRecord(analysis) {
  if (shouldBlockImageStorage(analysis)) return true;
  const confidence = Number(analysis?.confidence);
  if (!analysis || !Number.isFinite(confidence) || confidence < 0.8) return false;
  const details = [analysis.kind, ...(Array.isArray(analysis.tags) ? analysis.tags : []), analysis.caption]
    .map((item) => String(item ?? '').trim())
    .join(' ');
  if (PAYMENT_IMAGE.test(details)) return true;
  return analysis.valuable === false && CHAT_SCREENSHOT.test(details);
}

/** Move eligible records out of the active gallery, and remove sticker aliases only after the move succeeds. */
export function cleanupClassifiedImages({ images, analyses, quarantineImage, removeStickerAliases, logger = () => {} }) {
  const result = { scanned: Array.isArray(images) ? images.length : 0, matched: 0, quarantined: 0, aliasesRemoved: 0, failed: 0 };
  for (const image of Array.isArray(images) ? images : []) {
    const analysis = analyses?.[image.file];
    if (!shouldCleanImageArchiveRecord(analysis)) continue;
    result.matched += 1;
    const destination = quarantineImage(image.day, image.file);
    if (!destination) {
      result.failed += 1;
      logger('move-failed', image.file);
      continue;
    }
    result.quarantined += 1;
    try {
      result.aliasesRemoved += removeStickerAliases(image.file).length;
    } catch (error) {
      logger('alias-cleanup-failed', image.file, error?.message ?? error);
    }
  }
  return result;
}
