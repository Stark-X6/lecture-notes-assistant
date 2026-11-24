// Local structural evidence from indexed PDF lines. Physical page numbers
// always come from the import, including multi-slide handouts and running heads.
const label = (text) => text.normalize("NFKC").trim().replace(/\s+/gu, " ");
const compact = (text) =>
  label(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const frontMatter =
  /^(?:(?:第\s*[\d一二三四五六七八九十]+\s*[章讲]|chapter\s+[\divxlc]+)\s*[:—-]?\s*)?(?:目录|提纲|本章(?:目录|目标|提纲)|学习目标|教学目标|outline|contents|table of contents|agenda|learning objectives)\s*[:：]?$/iu;
const counter =
  /^(?:第\s*\d+\s*页|(?:page\s+)?\d+(?:\s*[-–/]\s*\d+)?|https?:\/\/.*)$/iu;
const slideCounter = /^([\p{L}][\p{L}\s]{0,40})\s+\d+\s*[-–]\s*\d+$/u;
const running =
  /^(?:\d+(?:\.\d+)+\s*[•·∙|]|(?:\d+\s+)?chapter\s+[\divxlc]+\s*[•·∙|]|\d+\s+chapter\b.+\d$)/iu;
const units =
  /^(?:[kmgtunµμ]?(?:bits?|b(?:it)?ps|b\/s|s|sec|hz|bytes?)(?:\/s)?|degrees?|percent)(?:\b|\/)/iu;
const yearRange = /^\d{4}\s*[-–—]\s*\d{4}$/u;
const bullet = /^[•●○▪□■◆◇►▶▸*·\uE000-\uF8FF]/u;
const usefulLine = (line) =>
  line.length > 1 &&
  line.length <= 110 &&
  !counter.test(line) &&
  !running.test(line) &&
  !/[。；;.!！]\s*$/u.test(line);

function numbered(line) {
  if (!usefulLine(line)) return null;
  const m = line.match(
    /^(\d+(?:\.\d+){1,5})[.、]?(?:\s+|(?=\p{Script=Han}))([\p{L}].*)$/u,
  );
  if (!m || units.test(m[2]) || /[;；]/u.test(m[2])) return null;
  return {
    number: m[1],
    level: m[1].split(".").length,
    text: m[2],
    title: m[1] + " " + m[2],
  };
}

function shortTitle(line) {
  if (
    !usefulLine(line) ||
    line.length > 70 ||
    bullet.test(line) ||
    frontMatter.test(line)
  )
    return false;
  if (/\p{Script=Han}/u.test(line)) return !/^[\d#]/u.test(line);
  return (
    /^[\p{L}]/u.test(line) &&
    line
      .split(" ")
      .every((w) =>
        /^(?:\p{Lu}|and$|the$|of$|in$|on$|for$|or$|to$|a$|an$|at$|with$|&$|\d)/u.test(
          w,
        ),
      )
  );
}

function formalHeading(line, following) {
  if (!usefulLine(line) || frontMatter.test(line)) return null;
  const markdown = line.match(/^(#{1,6})\s+(.+)$/u);
  if (markdown) return { level: markdown[1].length, title: markdown[2] };
  const numberedHeading = numbered(line);
  if (numberedHeading) {
    const next = following[0];
    if (
      next &&
      !/[?？]$/u.test(line) &&
      ((/\b(?:and|or|of|for|in|with|to)$|[:,–]$/iu.test(line) &&
        (shortTitle(next) || yearRange.test(next))) ||
        (/^(?:in|of|and|for|with|to)\s/u.test(next) && shortTitle(next)))
    )
      numberedHeading.title += " " + next;
    return numberedHeading;
  }
  if (
    /^(?:chapter\s+[\divxlc]+\s+)?(?:review questions|homework problems and questions|exercises|problems|复习题|课后习题)$/iu.test(
      line,
    )
  )
    return { level: 2, title: line };
  const cn = line.match(
    /^(第\s*[\d零〇一二三四五六七八九十百千]+\s*[章讲])(?:\s*[:—-]?\s*(.*))?$/u,
  );
  const en = line.match(
    /^(?:chapter\s+([\divxlc]+)(?:\s*[:—-]\s*|\s+)?(.*?)|([\divxlc]+)\s+chapter)$/iu,
  );
  if (cn || en) {
    const chapter = cn
      ? cn[1].replace(/\s/gu, "")
      : "Chapter " + (en[1] || en[3]);
    let title = cn ? cn[2] : en[2];
    if (title && !/^[\p{L}\p{N}]/u.test(title)) return null;
    const heading = cn ? cn[1] : chapter;
    if (!title) {
      const extra = [];
      for (const next of following.slice(0, cn ? 1 : 4)) {
        if (!shortTitle(next)) break;
        extra.push(next);
      }
      title = extra.join(" ");
    }
    return {
      level: 1,
      chapter,
      title: [heading, title].filter(Boolean).join(" ").slice(0, 120),
    };
  }
  if (/^第\s*[\d零〇一二三四五六七八九十百千]+\s*节/u.test(line))
    return { level: 2, title: line };
  return null;
}

function terms(title) {
  const tokens = new Set(title.toLowerCase().match(/[a-z][a-z0-9-]+/gu) || []);
  for (const script of title.match(/\p{Script=Han}+/gu) || [])
    for (let i = 1; i < script.length; i++)
      tokens.add(script.slice(i - 1, i + 1));
  for (const word of [
    "what",
    "is",
    "the",
    "and",
    "of",
    "for",
    "什么",
    "么是",
    "以及",
  ])
    tokens.delete(word);
  return [...tokens];
}

function matchScore(entry, body) {
  if (!body) return 0;
  if (body.includes(compact(entry.text))) return 2;
  const words = terms(entry.text);
  return words.length
    ? words.filter((w) => body.includes(w)).length / words.length
    : 0;
}

function agendaMarkers(blocks, records) {
  const groups = new Map();
  for (const [index, block] of blocks.entries()) {
    const signature = block.entries.map((r) => r.number).join(",");
    const occurrences = groups.get(signature) || [];
    occurrences.push({
      ...block,
      until: blocks[index + 1]?.start ?? records.length,
    });
    groups.set(signature, occurrences);
  }
  const markers = [];
  for (const occurrences of groups.values()) {
    const entries = occurrences[0].entries;
    if (entries.length > 300) continue;
    const body = (start, end) =>
      records.slice(start, end).filter((r) => !r.skip && !r.boiler);
    // Repeated slide agendas often introduce one teaching section apiece.
    // Anchor to the ensuing body, which can start on the next *physical* page.
    if (occurrences.length === entries.length) {
      for (const [i, b] of occurrences.entries()) {
        const content = body(b.end, b.until);
        const entry = entries[i];
        if (
          content.length &&
          matchScore(entry, compact(content.map((r) => r.line).join(" "))) >=
            0.35
        )
          markers.push({ ...entry, record: content[0] });
      }
    } else {
      // Single TOC or partial chapter. Establish openings from teaching text
      // in order. Listing a topic in the TOC alone cannot put it in the outline.
      const content = body(0, occurrences.at(-1).until);
      let cursor = 0;
      for (const entry of entries) {
        const index = content.findIndex(
          (r, i) =>
            i >= cursor &&
            r.line.length <= 120 &&
            matchScore(entry, compact(r.line)) >= 0.8,
        );
        if (index < 0) continue;
        markers.push({ ...entry, record: content[index] });
        cursor = index + 1;
      }
    }
  }
  return markers;
}

function scan(sources) {
  const records = [],
    prefixes = new Set(),
    leading = new Map();
  for (const p of sources) {
    const lines = p.text.split(/\r?\n/u).map(label).filter(Boolean);
    for (const line of new Set(lines.slice(0, 2)))
      leading.set(line, (leading.get(line) || 0) + 1);
    for (const [index, line] of lines.entries()) {
      const prefix = line.match(slideCounter);
      if (prefix) prefixes.add(prefix[1]);
      records.push({
        line,
        page: p.page,
        within: index,
        index: records.length,
      });
    }
  }
  const blocks = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i],
      line = r.line;
    r.boiler =
      counter.test(line) ||
      running.test(line) ||
      slideCounter.test(line) ||
      prefixes.has(line) ||
      (r.within <= 1 &&
        (leading.get(line) || 0) >= Math.max(3, sources.length * 0.6) &&
        !numbered(line) &&
        !/^(?:第|chapter|#)/iu.test(line));
    if (!frontMatter.test(line)) continue;
    r.skip = true;
    let end = i + 1;
    const entries = [];
    while (end < records.length && records[end].page === r.page) {
      const entry = numbered(records[end].line);
      if (entry) entries.push(entry);
      else if (!bullet.test(records[end].line) || entries.length) break;
      records[end++].skip = true;
    }
    if (entries.length >= 2) blocks.push({ start: i, end, entries });
  }
  const formal = [],
    numbers = new Set(),
    chapters = new Set(),
    titles = new Map(),
    first = new Map(),
    lineCounts = new Map();
  for (const r of records) {
    if (r.skip || r.boiler) continue;
    lineCounts.set(r.page, (lineCounts.get(r.page) || 0) + 1);
    if (!first.has(r.page)) first.set(r.page, r.index);
    if (
      !titles.has(r.page) &&
      r.within < 7 &&
      usefulLine(r.line) &&
      !bullet.test(r.line)
    )
      titles.set(
        r.page,
        r.line
          .replace(
            /\s*(?:\((?:续(?:上页)?|continued|cont\.?|\d+(?:\/\d+)?|[一二三四五六七八九十]+)\)|[-—–]\s*(?:续|continued))\s*$/iu,
            "",
          )
          .trim(),
      );
    const following = records
      .slice(r.index + 1, r.index + 5)
      .filter(
        (s) =>
          s.page === r.page && !s.skip && (!s.boiler || yearRange.test(s.line)),
      )
      .map((s) => s.line);
    const item = formalHeading(r.line, following);
    if (
      !item ||
      (item.number && numbers.has(item.number)) ||
      (item.chapter && chapters.has(item.chapter))
    )
      continue;
    if (item.number) numbers.add(item.number);
    if (item.chapter) chapters.add(item.chapter);
    formal.push({ ...item, record: r });
  }
  for (const item of agendaMarkers(blocks, records)) {
    if (numbers.has(item.number)) continue;
    numbers.add(item.number);
    formal.push(item);
  }
  // A closing review often appears only on the last slides, outside the
  // numbered agenda. Keep its continuation pages under one heading.
  if (formal.length) {
    const last = formal.reduce((a, b) =>
      a.record.index > b.record.index ? a : b,
    );
    const summary =
      /^((?:本章|章节)?(?:小结|总结)|(?:chapter\s+)?summary)(?:\s*(?:\d+|\(续\)|\(continued\)))?$/iu;
    if (!summary.test(last.title.replace(/^\d+(?:\.\d+)*\s+/u, ""))) {
      const closing = records.find(
        (r) =>
          r.index > last.record.index &&
          !r.skip &&
          !r.boiler &&
          summary.test(r.line),
      );
      if (closing)
        formal.push({
          level: 2,
          title: closing.line.match(summary)[1],
          record: closing,
        });
    }
  }
  const markers = formal
    .sort((a, b) => a.record.index - b.record.index || a.level - b.level)
    .map((r) => ({
      title: r.title,
      level: r.level,
      page: r.record.page,
      top: first.get(r.record.page) === r.record.index,
    }));
  return {
    markers,
    pageTitles: [...titles].map(([page, title]) => ({
      page,
      title,
      divider: lineCounts.get(page) === 1,
    })),
  };
}

module.exports = { scan, label };
