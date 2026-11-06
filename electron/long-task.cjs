const { check, clone, hash, validateResult } = require("./core.cjs");
// Bounded input batches with overlap. Intermediate validated results are durable;
// retry reuses them and only repeats failed or unfinished provider requests.
function splitSources(sources, size = 18000) {
  const pieces = [];
  for (const source of sources) {
    const body = source.text || "";
    for (let i = 0; i < Math.max(1, body.length); i += size)
      pieces.push({
        ...source,
        text: body.slice(i, i + size),
        part: Math.floor(i / size),
      });
  }
  const batches = [];
  let current = [],
    length = 0;
  for (const source of pieces) {
    if (current.length && length + source.text.length > size) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(source);
    length += source.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}
function boundedTopics(topics, sources, size = 18000) {
  const query = sources.map((s) => s.text).join("\n");
  const chosen = [...topics]
    .sort(
      (a, b) =>
        Number(query.includes(b.title)) - Number(query.includes(a.title)),
    )
    .slice(0, 40);
  const limit = Math.floor(Math.min(size, 16000) / Math.max(1, chosen.length));
  return chosen.map((t) => ({
    ...t,
    body: t.body.slice(0, limit),
    sources: t.sources?.filter((s) => sources.some((r) => r.id === s.id)) || [],
  }));
}
async function runLong(store, task, invoke, signal, preview) {
  const input = task.input,
    size = task.batchSize || 18000,
    batches = splitSources(input.sources, size);
  task.checkpoints ||= {};
  let output = [];
  async function request(label, value) {
    signal.throwIfAborted();
    check(task.state === "running", "任务已取消");
    const key = hash({ label, value });
    if (task.checkpoints[key]) return clone(task.checkpoints[key]);
    store.tx(() => {
      task.progress = {
        stage: label,
        completed: Object.keys(task.checkpoints).length,
        total: batches.length,
      };
    });
    const result = await invoke(
      { ...value, requestKey: task.key + ":" + key },
      preview,
    );
    signal.throwIfAborted();
    check(task.state === "running", "任务已取消");
    validateResult(result, value);
    store.tx(() => {
      task.checkpoints[key] = clone(result);
    });
    return result;
  }
  for (let i = 0; i < batches.length; i++) {
    const overlap = i
      ? batches[i - 1]
          .slice(-1)
          .map((s) => ({ ...s, text: s.text.slice(-Math.min(2000, size / 4)) }))
      : [];
    const sources = [...overlap, ...batches[i]];
    const value = {
      ...input,
      sources,
      utterances: [],
      history: (input.history || [])
        .slice(-12)
        .map((m) => ({
          role: m.role,
          text: m.text.slice(-Math.min(1500, size / 12)),
        })),
      topics: boundedTopics(input.topics, sources, size),
      prompt:
        input.prompt +
        `\n整课分批 ${i + 1}/${batches.length}：按主题组织，保留教师后续纠正、否定和来源；不要根据摘要臆造。`,
      provider: undefined,
    };
    const result = await request(`分析 ${i + 1}/${batches.length}`, value);
    output.push(...result.blocks);
  }
  // Reduce by stable existing topic ID or normalized new title; later batches
  // are passed after earlier evidence so corrections can supersede old claims.
  const groups = new Map();
  for (const block of output) {
    const key = block.topic_id.startsWith("new:")
      ? "new:" + block.title.trim().toLowerCase()
      : block.topic_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...block, topic_id: key });
  }
  const final = [];
  for (const [tid, blocks] of groups) {
    const baseline = input.topics.find((t) => t.id === tid);
    let merged = baseline
      ? {
          topic_id: tid,
          title: baseline.title,
          content_md: baseline.body,
          source_ids: baseline.sources
            .map((s) => s.id)
            .filter((id) => input.sources.some((s) => s.id === id)),
          evidence_type: "teacher_explanation",
        }
      : null;
    for (const [index, b] of blocks.entries()) {
      if (!merged) {
        merged = b;
        continue;
      }
      const ids = [...new Set([...merged.source_ids, ...b.source_ids])];
      const sources = ids
        .map((id) => input.sources.find((s) => s.id === id))
        .filter(Boolean)
        .map((s) => ({
          ...s,
          text: s.text.slice(0, Math.min(1200, Math.floor(18000 / ids.length))),
        }));
      const result = await request(
        `归并 ${b.title} ${index + 1}/${blocks.length}`,
        {
          ...input,
          utterances: [],
          history: [],
          sources,
          topics: [
            {
              id: tid,
              title: b.title,
              body: merged.content_md,
              version: baseline?.version || 0,
              sources: [],
            },
          ],
          context: { topicId: tid },
          provider: undefined,
          prompt: `${input.prompt}\n归并这一主题，仅返回一个块 topic_id=${tid}。保留原笔记正确内容、人工批注和来源，按课堂顺序采用后续明确纠正，不能简单拼接摘要。新增材料：${b.content_md}`,
        },
      );
      check(
        result.blocks.length === 1 && result.blocks[0].topic_id === tid,
        "主题归并返回了范围外内容",
      );
      merged = result.blocks[0];
    }
    final.push(merged);
  }
  // Validate each block separately, allowing more than 50 themes in a whole course.
  return { schema_version: "1", blocks: final };
}
module.exports = { runLong, splitSources };
