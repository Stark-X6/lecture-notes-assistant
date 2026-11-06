const { check } = require("./core.cjs");
function estimate(config, input) {
  const p = config.pricing;
  if (
    !p ||
    !Number.isFinite(p.inputPerMillion) ||
    !Number.isFinite(p.outputPerMillion)
  )
    return null;
  // Conservative UTF-8 byte upper bound, plus system-message overhead.
  return (
    ((Buffer.byteLength(JSON.stringify(input), "utf8") + 6000) *
      p.inputPerMillion +
      config.maxOutput * p.outputPerMillion) /
    1e6
  );
}
function reserve(store, task, input) {
  const cfg = store.s.config;
  if (task.input.provider.mode !== "http") return null;
  const amount = estimate(cfg, input),
    budget = cfg.pricing?.budget;
  const used = store.s.tasks.reduce((n, t) => n + (t.costReserved || 0), 0);
  if (Number.isFinite(budget)) {
    check(
      amount !== null,
      "已设置金额预算，但缺少价格；暂停文本调用，请补齐价格",
    );
    check(
      used + amount <= budget,
      "文本 API 估算金额达到预算；请调整预算后重试",
    );
  }
  store.tx(() => {
    task.costReserved = (task.costReserved || 0) + (amount || 0);
    task.costUnknown ||= amount === null;
    task.requests = (task.requests || 0) + 1;
  });
  return amount;
}
function account(store, task, result, reserved) {
  const p = store.s.config.pricing,
    u = result._usage;
  store.tx(() => {
    if (u) {
      task.usage ||= { prompt_tokens: 0, completion_tokens: 0 };
      task.usage.prompt_tokens += u.prompt_tokens || 0;
      task.usage.completion_tokens += u.completion_tokens || 0;
    }
    if (
      reserved != null &&
      Number.isFinite(u?.prompt_tokens) &&
      Number.isFinite(u?.completion_tokens)
    ) {
      const actual =
        (u.prompt_tokens * p.inputPerMillion +
          u.completion_tokens * p.outputPerMillion) /
        1e6;
      task.costReserved = Math.max(0, task.costReserved - reserved + actual);
      task.costActual = (task.costActual || 0) + actual;
    } else if (task.input.provider.mode === "http") task.usageMissing = true;
  });
}
module.exports = { estimate, reserve, account };
