function sourceLabels(sources) {
  return sources.map(
    (s, i) =>
      `[${i + 1}] ${s.name || s.lessonName || "课堂转录"}${s.page ? ` 第${s.page}页` : s.startMs != null ? ` ${Math.floor(s.startMs / 1000)}–${Math.floor(s.endMs / 1000)}秒` : ` 版本${s.revision || 1}`}`,
  );
}

function withoutSourceList(body, sources) {
  const marker = "\n<!-- generated-sources -->\n";
  const start = body.indexOf(marker);
  if (start < 0) return body;
  const labels = sourceLabels(sources);
  const tail = body.slice(start + marker.length);
  for (const expected of [
    labels.join("；"),
    labels.map((r) => "- " + r).join("\n"),
  ]) {
    if (expected && (tail === expected || tail.startsWith(expected + "\n")))
      return body.slice(0, start) + tail.slice(expected.length);
  }
  return body.replace(marker, "\n");
}

// Preserve hand-written text after the generated source list.
function format(body, rules = {}, sources = []) {
  body = withoutSourceList(body, sources);
  const counts = [0, 0, 0, 0, 0, 0],
    cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  let fence = false;
  body = body
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const level = m[1].length - 1;
        counts[level]++;
        counts.fill(0, level + 1);
        let label = m[2].replace(
          /^(?:\d+(?:\.\d+)*[.、]?\s+|[一二三四五六七八九十]+、\s*)/,
          "",
        );
        if (rules.heading_numbering === "层级编号")
          label =
            counts
              .slice(0, level + 1)
              .filter(Boolean)
              .join(".") +
            " " +
            label;
        if (rules.heading_numbering === "中文序号")
          label = (cn[counts[level] - 1] || counts[level]) + "、" + label;
        return m[1] + " " + label;
      }
      if (rules.list_style === "项目符号")
        line = line.replace(/^(\s*)\d+[.)]\s+/, "$1- ");
      if (rules.emphasis_style !== "纯文本")
        line = line.replace(
          /(?<!\*\*)【(教师强调|推断重点|考试要求|待核实)】(?!\*\*)/g,
          "**【$1】**",
        );
      if (rules.image_policy === "只给链接")
        line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");
      return line;
    })
    .join("\n");
  if (sources.length) {
    const refs = sourceLabels(sources);
    body +=
      "\n<!-- generated-sources -->\n" +
      (rules.source_format === "行内引用"
        ? refs.join("；")
        : refs.map((r) => "- " + r).join("\n"));
  }
  return body;
}
function chapterSections(notebook, topics, materials) {
  const order = notebook.outline?.topicIds || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered = [...topics].sort(
    (a, b) =>
      (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
  );
  const ids = new Set(topics.map((t) => t.id));
  const children = new Map();
  for (const topic of ordered) {
    const parent = ids.has(topic.parentId) ? topic.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(topic);
  }
  const source = materials.find((m) => m.id === notebook.outline?.materialId);
  const sections = [],
    visited = new Set();
  function visit(topic, level) {
    if (visited.has(topic.id)) return;
    visited.add(topic.id);
    let heading = "#".repeat(level) + " " + topic.title;
    const range = topic.outlineRange;
    if (rank.has(topic.id) && source && range?.materialId === source.id) {
      const pages =
        range.from === range.to ? range.from : `${range.from}–${range.to}`;
      heading += `\n\n> 骨架依据：${source.name}，第 ${pages} 页`;
    }
    sections.push({ topic, level, heading });
    for (const child of children.get(topic.id) || [])
      visit(child, Math.min(6, level + 1));
  }
  for (const root of children.get(null) || []) visit(root, 2);
  // Match the reader's fallback for historical notes with a circular parent.
  for (const topic of ordered) if (!visited.has(topic.id)) visit(topic, 2);
  return sections;
}
function chapterHeadings(notebook, topics, materials) {
  return new Map(
    chapterSections(notebook, topics, materials).map(({ topic, heading }) => [
      topic.id,
      heading,
    ]),
  );
}
function nestMarkdown(body, sectionLevel) {
  const { mapProseLines } = require("./markdown-prose.cjs");
  const headings = new Map();
  mapProseLines(body, (line, index) => {
    const m = line.match(/^( {0,3})(#{1,6})[ \t]+(.+)$/);
    if (m) headings.set(index, m);
    return line;
  });
  if (!headings.size) return body;
  let shallowest = 6;
  for (const m of headings.values())
    shallowest = Math.min(shallowest, m[2].length);
  return body
    .split("\n")
    .map((line, index) => {
      const m = headings.get(index);
      if (!m) return line;
      const depth = sectionLevel + 1 + m[2].length - shallowest;
      return depth <= 6
        ? m[1] + "#".repeat(depth) + " " + m[3]
        : m[1] + "**" + m[3] + "**";
    })
    .join("\n");
}
module.exports = {
  format,
  withoutSourceList,
  chapterHeadings,
  chapterSections,
  nestMarkdown,
};
