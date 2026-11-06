const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module"),
  ts = require("typescript");
const file = path.resolve("src/transcriptSelection.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const loaded = new Module(file, module);
loaded._compile(compiled, file);
const {
  parseTimestamp,
  formatTimestamp,
  selectTimeRange,
  selectParagraphRange,
  groupTranscript,
} = loaded.exports;
const row = (id, startMs, endMs, final = true) => ({
  id,
  text: id,
  startMs,
  endMs,
  final,
});
test("时间输入支持秒、跨小时与毫秒，拒绝错误进位和无效值", () => {
  for (const [value, want] of [
    ["90", 90000],
    ["01:05", 65000],
    ["75:30", 4530000],
    ["1:02:03.004", 3723004],
    [" 0.005 ", 5],
  ])
    assert.equal(parseTimestamp(value), want);
  for (const value of ["", "-1", "1:60", "1:60:00", "abc", "1:2:3:4", "0.0001"])
    assert.equal(parseTimestamp(value), null);
  assert.equal(formatTimestamp(3723004), "1:02:03.004");
});
test("半开时间区间按完整源句相交选择，排除临时与无时间戳段落", () => {
  const rows = [
    row("before", 0, 10000),
    row("atStart", 10000, 20000),
    row("overlap", 20000, 40000),
    row("point", 30000, 30000),
    row("atEnd", 40000, 50000),
    row("pending", 11000, 12000, false),
    row("text", null, null),
  ];
  assert.deepEqual(selectTimeRange(rows, 10000, 40000), [
    "atStart",
    "overlap",
    "point",
  ]);
  assert.throws(() => selectTimeRange(rows, 10000, 10000));
  assert.throws(() => selectTimeRange(rows, -1, 10));
  assert.deepEqual(selectTimeRange(rows, 60000, 70000), []);
});
test("段落范围保留原始导入顺序，不按时间重新编号", () => {
  const rows = [
    row("late", 40000, 50000),
    row("text", null, null),
    row("early", 0, 10000),
    row("pending", 11000, 12000, false),
  ];
  assert.deepEqual(selectParagraphRange(rows, 1, 2), ["late", "text"]);
  assert.deepEqual(selectParagraphRange(rows, 3, 4), ["early"]);
  assert.throws(() => selectParagraphRange(rows, 0, 2));
  assert.throws(() => selectParagraphRange(rows, 1, 5));
});
test("阅读分组减少时间戳，主题变化仍保持边界和原始ID", () => {
  const rows = [
    row("a", 0, 5000),
    row("b", 5000, 9000),
    { ...row("c", 9000, 15000), topicId: "topic" },
    row("d", 65000, 70000),
  ];
  const groups = groupTranscript(rows);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0].items.map((u) => u.id),
    ["a", "b"],
  );
  assert.deepEqual(
    groups.flatMap((g) => g.items.map((u) => u.id)),
    ["a", "b", "c", "d"],
  );
});
