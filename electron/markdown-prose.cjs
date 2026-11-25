// Leave Markdown code and display math untouched when adjusting the prose around them.
function mapProseLines(body, visit) {
  let fence = "",
    math = false,
    offset = 0;
  return body
    .split("\n")
    .map((line, index) => {
      const start = offset;
      offset += line.length + 1;
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          delimiter &&
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = "";
        return line;
      }
      if (line.trim().startsWith("$$")) {
        if (line.trim() === "$$" || !line.trim().endsWith("$$")) math = !math;
        return line;
      }
      if (math || /^(?: {4}|\t)/.test(line)) return line;
      if (delimiter) {
        fence = delimiter[1];
        return line;
      }
      return visit(line, index, start);
    })
    .join("\n");
}

function appendParagraphs(original, addition) {
  if (!original) return addition;
  if (!addition) return original;
  const body = original.replaceAll("\r\n", "\n");
  const passage = addition.replaceAll("\r\n", "\n");
  if (body.includes(passage)) {
    const starts = new Set([0]);
    const ends = new Set([body.length]);
    mapProseLines(body, (line, _index, offset) => {
      if (!line.trim()) {
        ends.add(offset - 1);
        starts.add(offset + line.length + 1);
      }
      return line;
    });
    for (const start of starts)
      if (ends.has(start + passage.length) && body.startsWith(passage, start))
        return original;
  }
  return original + "\n\n" + addition;
}
module.exports = { mapProseLines, appendParagraphs };
