const { mapProseLines } = require("./markdown-prose.cjs");
const alias = /^([SBT])(\d+)(?:\s*[-–—~至]\s*\1(\d+))?$/;
const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return (
    String(Math.floor(seconds / 60)).padStart(2, "0") +
    ":" +
    String(seconds % 60).padStart(2, "0")
  );
};
const span = (start, end) =>
  clock(start) === clock(end) ? clock(start) : clock(start) + "–" + clock(end);
function renderGroup(text, refs, declared, ambiguous) {
  const items = text.trim().split(/\s*[,，、;；]\s*/u);
  const locations = new Map();
  function add(label, value) {
    if (!locations.has(label)) locations.set(label, new Set());
    locations.get(label).add(value);
  }
  let evidenced = false;
  for (const item of items) {
    const m = item.match(alias);
    if (!m) return null;
    const first = Number(m[2]),
      last = m[3] ? Number(m[3]) : first;
    if (first > last || last - first >= refs.size) return null;
    const run = [];
    for (let i = first; i <= last; i++) {
      const k = m[1] + i,
        r = refs.get(k);
      if (!r) return null;
      evidenced ||= declared.has(k);
      run.push(r);
    }
    if (m[1] !== "T") {
      for (const r of run) {
        if (!Number.isInteger(r.page)) return null;
        const role = r.materialRole === "book" ? "教材" : "课件";
        const file = ambiguous.has(r.materialRole) ? "《" + r.name + "》" : "";
        add(
          role + file + (/\.pdf$/iu.test(r.name || "") ? " PDF 第" : "第"),
          r.page,
        );
      }
    } else {
      const head = run[0];
      if (run.some((r) => r.lessonId !== head.lessonId)) return null;
      if (run.some((r) => r.startMs == null || r.endMs == null)) {
        if (run.some((r) => !Number.isInteger(r.paragraph))) return null;
        for (const r of run) add("转录第", r.paragraph);
      } else {
        let begin = head.startMs,
          end = head.endMs;
        for (let i = 1; i < run.length; i++) {
          const r = run[i],
            prev = run[i - 1];
          if (r.startMs < prev.startMs) return null;
          if (
            r.startMs > end + 1000 &&
            !(prev.paragraph && r.paragraph === prev.paragraph + 1)
          ) {
            add("课堂", span(begin, end));
            begin = r.startMs;
          }
          end = r.endMs;
        }
        add("课堂", span(begin, end));
      }
    }
  }
  if (!evidenced) return null;
  return [...locations]
    .map(([label, parts]) => {
      if (label === "课堂") return label + " " + [...parts].join("、");
      const ranges = [];
      for (const n of [...parts].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && n === last[1] + 1) last[1] = n;
        else ranges.push([n, n]);
      }
      const numbers = ranges
        .map(([a, b]) => (a === b ? a : a + "–" + b))
        .join("、");
      return label + " " + numbers + (label === "转录第" ? " 段" : " 页");
    })
    .join("，");
}
// Aliases are local to an individual model request. Never guess their meaning
// from the complete notebook or substitute bare technical terms such as T1.
function readableCitations(body, refs, sourceIds) {
  if (typeof body !== "string" || !/[BST]\d/.test(body)) return body;
  const declared = new Set(sourceIds);
  const documents = new Map(),
    ambiguous = new Set();
  for (const r of refs.values()) {
    if (!r || !r.materialRole) continue;
    const doc = r.targetId || r.name;
    if (documents.has(r.materialRole) && documents.get(r.materialRole) !== doc)
      ambiguous.add(r.materialRole);
    documents.set(r.materialRole, doc);
  }
  return mapProseLines(body, (line) =>
    line
      .split(/(`+[^`]*`+|\$[^$\n]+\$)/g)
      .map((part, i) => {
        if (i % 2) return part;
        const footer = part.match(
          /^(\s*(?:[-*]\s+)?(?:\*\*)?(?:来源|引用|Sources?)(?:\*\*)?\s*[:：]\s*)([^。]+?)[。.]?\s*$/i,
        );
        if (footer) {
          const tokens =
            footer[2].match(/[STB]\d+(?:\s*[-–—~至]\s*[STB]\d+)?/g) || [];
          const rest = footer[2]
            .replace(/[STB]\d+(?:\s*[-–—~至]\s*[STB]\d+)?/g, "")
            .replace(
              /\[[STB]\]|课件|幻灯片|教材|课堂转写|课堂|转录|[\s\[\]（）、,，;；]/g,
              "",
            );
          if (tokens.length && !rest) {
            if (tokens.every((k) => declared.has(k))) return "";
            const loc = renderGroup(
              tokens.join(","),
              refs,
              declared,
              ambiguous,
            );
            if (loc) return footer[1] + loc + "。";
          }
        }
        return part.replace(
          /[（(\[]([SBT]\d[^()（）\[\]\n]*?)[）)\]](?!\()/g,
          (raw, group) => {
            const loc = renderGroup(group, refs, declared, ambiguous);
            return loc ? "（" + loc + "）" : raw;
          },
        );
      })
      .join(""),
  );
}
module.exports = { readableCitations };
