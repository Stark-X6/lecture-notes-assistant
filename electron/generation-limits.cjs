// Bounded capacities for modern large-output models. Token limits remain
// user configured; these are memory/transport guards, not output targets.
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 393216;
const MAX_NOTE_CHARS = MAX_OUTPUT_TOKENS * 16;
function responseLimits(maxOutput) {
  const tokens = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Number.isInteger(maxOutput) ? maxOutput : 3000),
  );
  return {
    maxTextChars: Math.max(500000, tokens * 16),
    maxWireBytes: Math.max(2000000, tokens * 512),
  };
}
module.exports = {
  MIN_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_NOTE_CHARS,
  responseLimits,
};
