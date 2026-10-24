const AUTO_USE_CONFIDENCE = 0.75;
const AUTO_DISCARD_CONFIDENCE = 0.75;
const DUPLICATE_CONFIDENCE = 0.8;

/** Decide whether a recognized sticker should be enrolled, reviewed, or skipped. */
export function decideStickerHandling(analysis, duplicate) {
  const confidence = Number(analysis?.confidence) || 0;
  if (analysis?.sticker !== true) return { archive: true, status: null, reason: 'not-sticker' };

  if (duplicate?.duplicate === true && Number(duplicate.confidence) >= DUPLICATE_CONFIDENCE) {
    return { archive: false, status: null, reason: 'duplicate' };
  }
  if (analysis.valuable === false && confidence >= AUTO_DISCARD_CONFIDENCE) {
    return { archive: false, status: null, reason: 'low-value' };
  }
  if (analysis.appropriate === false) return { archive: true, status: 'rejected', reason: 'inappropriate' };
  if (analysis.valuable === true && confidence >= AUTO_USE_CONFIDENCE && duplicate?.duplicate === false) {
    return { archive: true, status: 'approved', reason: 'valuable' };
  }
  return { archive: true, status: 'pending', reason: 'uncertain' };
}
