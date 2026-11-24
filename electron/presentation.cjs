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
function chapterHeadings(notebook, topics, materials) {
  const members = new Set(notebook.outline?.topicIds || []);
  const byId = new Map(topics.map((t) => [t.id, t]));
  const source = materials.find((m) => m.id === notebook.outline?.materialId);
  return new Map(
    topics.map((topic) => {
      let level = 2,
        parentId = topic.parentId;
      const seen = new Set([topic.id]);
      while (
        members.has(topic.id) &&
        members.has(parentId) &&
        byId.has(parentId) &&
        !seen.has(parentId)
      ) {
        seen.add(parentId);
        level++;
        parentId = byId.get(parentId).parentId;
      }
      let heading = "#".repeat(Math.min(level, 6)) + " " + topic.title;
      const range = topic.outlineRange;
      if (members.has(topic.id) && source && range?.materialId === source.id) {
        const pages =
          range.from === range.to ? range.from : `${range.from}–${range.to}`;
        heading += `\n\n> 骨架依据：${source.name}，第 ${pages} 页`;
      }
      return [topic.id, heading];
    }),
  );
}
module.exports = { format, withoutSourceList, chapterHeadings };
