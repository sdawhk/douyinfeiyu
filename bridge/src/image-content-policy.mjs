export const IMAGE_SAFETY_CONFIDENCE = 0.75;

/** Keep sexualized or graphic/disgusting images out of persistent storage. */
export function shouldBlockImageStorage(analysis) {
  const confidence = Number(analysis?.confidence);
  if (!analysis || !Number.isFinite(confidence) || confidence < IMAGE_SAFETY_CONFIDENCE) return false;
  return analysis.appropriate === false
    || analysis.sexualSuggestive === true
    || analysis.grossOrGraphic === true;
}
