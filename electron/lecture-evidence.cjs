function titleKey(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/以及|[和与及]|\band\b|[\s\p{P}]/gu, "");
}

function introduction(input) {
  if (!input.whole || !input.noteScope?.requiresSlides) return null;
  const labels = [];
  for (const page of input.sources.filter((s) => s.materialRole === "slides")) {
    if (!/提纲|大纲|目录|\b(?:outline|agenda|contents)\b/i.test(page.text))
      continue;
    for (const line of page.text.split("\n")) {
      const item = line.match(/^\s*\d+(?:\.\d+)+\s+(.{2,100})$/);
      if (item) labels.push(titleKey(item[1]));
    }
  }
  if (!labels.length) return null;
  const turns = input.utterances;
  // Require both the lecturer's recap of the agenda and a subsequent explicit
  // move into the lesson. Elapsed time alone says nothing about its content.
  const recap =
    /(?:以上(?:就是|是|为)?|这(?:就)?是)(?:我们)?(?:这(?:一)?章|本章|本节|这节课)(?:的)?(?:主要)?(?:提纲|大纲|安排|内容|概览)|(?:that (?:was|is)|so much for) (?:our |the )?(?:agenda|outline)/i;
  const begin =
    /(?:首先|下面|接下来|现在).{0,18}(?:进入|来?看|开始|来?讲)|(?:now|first).{0,20}(?:start|begin|look at)/i;
  const boundary = turns.findIndex(
    (turn, i) =>
      recap.test(turn.text) &&
      begin.test(
        turns
          .slice(i + 1, i + 5)
          .map((u) => u.text)
          .join(" "),
      ),
  );
  if (boundary < 0 || boundary >= turns.length / 2) return null;
  return {
    before: new Set(
      turns.slice(0, boundary + 1).map((u) => `u:${u.id}:${u.revision}`),
    ),
    labels: labels.filter((label) => label.length >= 4),
  };
}

function isIntroductory(section, title, sources) {
  if (!section) return false;
  const speech = sources.filter((s) => s.kind === "transcript");
  const early = speech.filter((s) => section.before.has(s.id)).length;
  if (!early) return false;
  if (early === speech.length) return true;
  const key = titleKey(title);
  return (
    early > speech.length - early &&
    section.labels.some((label) => key.includes(label))
  );
}

function qualifyEmphasis(body, sources) {
  if (!body.includes("【教师强调】")) return body;
  const speech = sources.filter((s) => s.kind === "transcript");
  const cue =
    /强调|重点|重要|牢记|注意|务必|必须(?:要)?(?:掌握|理解|熟悉|记住)|需要(?:掌握|记住)|\b(?:important|emphasi[sz]e|must remember)\b/i;
  if (speech.some((s) => cue.test(s.text))) return body;
  return body.replaceAll(
    "【教师强调】",
    speech.length ? "【课堂讲解】" : "【整理提示】",
  );
}

module.exports = { introduction, isIntroductory, qualifyEmphasis };
