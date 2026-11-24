const providers = require("./text-providers.json");

function textTarget(config) {
  // Unmarked installations and frozen jobs always used Chat Completions.
  // Other paths on the DeepSeek host must keep their original request URL.
  const legacy = config.textProvider === undefined;
  const url = config.textUrl ?? "";
  const provider = legacy
    ? url === providers.deepseek.url
      ? "deepseek"
      : "compatible"
    : config.textProvider;
  if (typeof provider !== "string" || !Object.hasOwn(providers, provider))
    throw Object.assign(new Error("请选择支持的文本提供商"), {
      code: "INVALID_INPUT",
    });
  return {
    provider,
    url: provider === "compatible" ? url : providers[provider].url,
  };
}

function textCredential(config) {
  const { provider, url } = textTarget(config);
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
      return provider + "|" + parsed.origin;
  } catch {
    // Offline or older settings can have no usable endpoint.
  }
  return null;
}

function encryptedTextKey(state, config) {
  const scope = textCredential(config);
  return (scope && state.secrets.textKeys?.[scope]) || "";
}

function migrateTextSettings(state) {
  state.config ||= {};
  state.secrets ||= {};
  if (state.config.textProvider !== undefined) return;
  // The original Store supplied this address only when reading a database
  // with no textUrl field. A malformed request or job has no such default.
  if (!Object.hasOwn(state.config, "textUrl"))
    state.config.textUrl = "https://api.openai.com/v1/chat/completions";
  const { provider, url } = textTarget(state.config);
  Object.assign(state.config, { textProvider: provider, textUrl: url });
  const scope = textCredential(state.config);
  if (scope && state.secrets.text) {
    state.secrets.textKeys ||= {};
    state.secrets.textKeys[scope] ??= state.secrets.text;
    delete state.secrets.text;
  }
}

function textProfile({ textUrl, textModel, textThinking, maxOutput }) {
  return { textUrl, textModel, textThinking, maxOutput };
}

module.exports = {
  textTarget,
  textCredential,
  encryptedTextKey,
  migrateTextSettings,
  textProfile,
};
