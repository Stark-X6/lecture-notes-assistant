// Deterministic presentation rules; detail level remains a content-generation
// instruction and never deletes factual paragraphs after generation.
function format(body, rules = {}, sources = []) {
  body = body.replace(/\n<!-- generated-sources -->[\s\S]*$/, "");
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
        line = line.replace(/^\s*\d+[.)]\s+/, "- ");
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
    const refs = sources.map(
      (s, i) =>
        `[${i + 1}] ${s.name || s.lessonName || "课堂转录"}${s.page ? ` 第${s.page}页` : s.startMs != null ? ` ${Math.floor(s.startMs / 1000)}–${Math.floor(s.endMs / 1000)}秒` : ` 版本${s.revision || 1}`}`,
    );
    body +=
      "\n<!-- generated-sources -->\n" +
      (rules.source_format === "行内引用"
        ? refs.join("；")
        : refs.map((r) => "- " + r).join("\n"));
  }
  return body;
}
module.exports = { format };
