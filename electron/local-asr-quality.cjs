// Detect a full prompt echo, without deleting or rewriting recognized words.
function review(text, hotwords = "") {
  const terms = hotwords
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const prompt = normalize(terms.join(""));
  const needsReview =
    terms.length >= 4 &&
    prompt.length >= 16 &&
    normalize(text).includes(prompt);
  return {
    needsReview,
    reviewReason: needsReview ? "识别结果疑似复述课程术语，请回听核对" : null,
  };
}
module.exports = { review };
