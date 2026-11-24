const BOOK_PAGE_LIMIT = 18;
const BOOK_EXCERPT_CHARS = 3600;
const stopwords = new Set(
  "the of for an and or with from that this which what are was have chapter introduction contents edition section figure table 什么 么是 以及".split(
    " ",
  ),
);

function keywords(text) {
  const words = new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []);
  for (const phrase of text.match(/\p{Script=Han}{2,}/gu) || [])
    for (let i = 0; i < phrase.length - 1; i++)
      words.add(phrase.slice(i, i + 2));
  for (const word of stopwords) words.delete(word);
  return words;
}

const numberedTitle = /^\s*(\d+(?:\.\d+)+)\s+(.{2,100})\s*$/u;
const nonBody =
  /^\s*(?:[\divxlc]+\s+)?(?:table of contents\b|preface\b|index\b|about the authors?\b|acknowledg(?:e)?ments\b|目录|前言|致谢|索引)/im;

// Section numbers are useful across languages only when the title also matches
// vocabulary actually present in the teaching material outside its agenda.
function matchingSections(pages, queries) {
  const lines = queries.flatMap((text) => text.normalize("NFKC").split("\n"));
  const teaching = keywords(
    lines.filter((line) => !numberedTitle.test(line)).join("\n"),
  );
  const titles = new Map();
  for (const line of lines) {
    const entry = line.match(numberedTitle);
    if (!entry) continue;
    const terms = [...keywords(entry[2])].filter((word) => teaching.has(word));
    if (terms.length) titles.set(entry[1], terms);
  }
  if (!titles.size) return [];
  const sections = new Map();
  for (const p of pages) {
    // Include section openings in the middle of a page and running headings.
    for (const match of p.text.matchAll(
      /^[ \t]*(\d+(?:\.\d+)+)[ \t]+([^\n]{2,100})$/gm,
    )) {
      const terms = titles.get(match[1]);
      if (!terms) continue;
      const heading = keywords(match[2]);
      if (!terms.some((word) => heading.has(word))) continue;
      const entries = sections.get(match[1]) || [];
      entries.push({
        page: p.page,
        offset: match.index,
        running: /^[ \t]*[•·|]/.test(match[2]),
      });
      sections.set(match[1], entries);
    }
  }
  const selected = new Map();
  for (const [section, hits] of sections) {
    const opening = hits.find((h) => !h.running);
    const first = opening?.page ?? Math.max(1, hits[0].page - 1);
    const last = hits.at(-1).page;
    // Distant references to the same heading are not one continuous passage.
    if (last - first >= BOOK_PAGE_LIMIT) continue;
    for (const p of pages) {
      const lastPossible = opening ? first + BOOK_PAGE_LIMIT - 1 : last + 2;
      if (p.page < first || p.page > lastPossible) continue;
      const from = p.page === opening?.page ? opening.offset : 0;
      const text = p.text.slice(from);
      const next = [
        ...text.matchAll(/^[ \t]*(\d+(?:\.\d+)+)[ \t]+([^\n]{2,100})$/gm),
      ].find(
        (m) =>
          m[1] !== section &&
          !m[1].startsWith(section + ".") &&
          !/^[ \t]*[•·|]/.test(m[2]) &&
          m[1].split(".").length <= section.split(".").length,
      );
      const to = next ? from + next.index : p.text.length;
      if (p.text.slice(from, to).trim()) {
        const prior = selected.get(p.page);
        selected.set(p.page, {
          source: p,
          from: Math.min(from, prior?.from ?? from),
          to: Math.max(to, prior?.to ?? to),
        });
      }
      if (next) break;
    }
  }
  return [...selected.values()]
    .map(({ source, from, to }) => ({
      ...source,
      text: source.text.slice(from, to).trim(),
    }))
    .sort((a, b) => a.page - b.page);
}

function textbookPages(pages, queries) {
  const body = pages.filter(
    (p) =>
      p.text.trim() &&
      !nonBody.test(p.text.slice(0, 130)) &&
      !nonBody.test(p.text.slice(-130)),
  );
  const section = matchingSections(body, queries);
  const best =
    section.length && section.length <= BOOK_PAGE_LIMIT
      ? section
      : relevant(section.length ? section : body, queries, BOOK_PAGE_LIMIT);
  return best.map((p) => ({ ...p, text: p.text.slice(0, BOOK_EXCERPT_CHARS) }));
}

function relevant(pages, queries, limit) {
  const index = new Map();
  for (const page of pages)
    for (const word of keywords(page.text)) {
      if (!index.has(word)) index.set(word, []);
      index.get(word).push(page);
    }
  const scores = new Map();
  for (const query of queries) {
    const matches = new Map();
    for (const word of keywords(query)) {
      const relevantPages = index.get(word);
      if (!relevantPages) continue;
      const weight = 1 / Math.sqrt(relevantPages.length);
      for (const page of relevantPages) {
        if (!matches.has(page)) matches.set(page, { page, score: 0, hits: 0 });
        const match = matches.get(page);
        match.hits += /^[a-z]/.test(word) ? 2 : 1;
        match.score += weight;
      }
    }
    const ranked = [...matches.values()]
      .filter((x) => x.hits >= 2)
      .sort((a, b) => b.score - a.score || a.page.page - b.page.page);
    for (const { page, score } of ranked.slice(0, Math.min(3, limit))) {
      if (score < ranked[0].score * 0.4) continue;
      scores.set(page, Math.max(scores.get(page) || 0, score));
    }
  }
  return [...scores.entries()]
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.page - b.page)
    .slice(0, limit)
    .map(([page]) => page)
    .sort((a, b) => a.page - b.page);
}

function pageRefs(material, role, from = 1, to = material.pages.length) {
  return material.pages.slice(from - 1, to).map((body, index) => {
    const page = index + from;
    return {
      id: `p:${material.id}:${page}:${material.sha}`,
      version: material.sha,
      kind: "material",
      materialRole: role,
      targetId: material.id,
      page,
      name: material.name,
      text: body,
    };
  });
}

function outlineForPages(material, pages) {
  const matched = [];
  for (const node of material?.outline || []) {
    const selected = pages.filter(
      (page) => page >= node.from && page <= node.to,
    );
    if (!selected.length) continue;
    matched.push({ title: node.title, pages: selected });
  }
  return matched.sort(
    (a, b) => a.pages[0] - b.pages[0] || a.pages.length - b.pages.length,
  );
}

function scopedBatch(input, sources) {
  const slides = sources.filter((s) => s.materialRole === "slides");
  const selected = input.sources.filter((s) => s.materialRole === "slides");
  if (!slides.length && selected.length) {
    const matches = relevant(
      selected,
      [sources.map((s) => s.text).join(" ")],
      6,
    );
    for (const slide of matches.length ? matches : selected.slice(0, 4))
      sources.push({ ...slide, text: slide.text.slice(0, 1300) });
  }
  const queries = sources
    .filter((s) => s.materialRole === "slides")
    .map((s) => s.text);
  const book = input.sources.filter((s) => s.materialRole === "book");
  if (book.reduce((n, p) => n + p.text.length, 0) <= 28000)
    return [...sources, ...book];
  const matches = relevant(
    book,
    queries.length ? queries : [sources.map((s) => s.text).join(" ")],
    6,
  );
  return [...sources, ...matches];
}

function position(block, input) {
  const refs = input.sources.filter((source) =>
    block.source_ids.includes(source.id),
  );
  for (const role of [input.noteScope.order, "slides"]) {
    const first = refs
      .filter((r) => r.materialRole === role)
      .sort((a, b) => a.page - b.page)[0];
    if (first)
      return {
        materialId: first.targetId,
        page: first.page,
        fallback: role !== input.noteScope.order,
      };
  }
  return { page: Infinity, fallback: true };
}

function structureForSources(input, sources) {
  if (!input.noteScope) return input.structure;
  const pages = new Set(
    sources
      .filter((s) => s.materialRole === input.noteScope.order)
      .map((s) => s.page),
  );
  return input.structure.flatMap((node) => {
    const selected = node.pages.filter((p) => pages.has(p));
    return selected.length ? [{ ...node, pages: selected }] : [];
  });
}

module.exports = {
  textbookPages,
  pageRefs,
  relevant,
  outlineForPages,
  scopedBatch,
  position,
  structureForSources,
};
