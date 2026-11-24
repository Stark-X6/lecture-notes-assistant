// Leave Markdown code and display math untouched when adjusting the prose around them.
function mapProseLines(body, visit) {
  let fence = "",
    math = false;
  return body
    .split("\n")
    .map((line, index) => {
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
      return visit(line, index);
    })
    .join("\n");
}
module.exports = { mapProseLines };
