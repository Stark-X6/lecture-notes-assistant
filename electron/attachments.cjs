const fs = require("node:fs"),
  path = require("node:path");
const { id, check, atomicWrite } = require("./core.cjs");
function imageType(data) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return ["png", "image/png"];
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return ["jpg", "image/jpeg"];
  if (data.toString("ascii", 0, 3) === "GIF") return ["gif", "image/gif"];
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return ["webp", "image/webp"];
  throw new Error("仅支持 PNG、JPEG、GIF、WebP 图片");
}
function add(store, cid, file) {
  store.course(cid);
  check(fs.statSync(file).size <= 20 * 1024 * 1024, "图片不能超过20MB");
  const data = fs.readFileSync(file),
    [ext, mime] = imageType(data),
    aid = id();
  const target = path.join(
    store.root,
    "courses",
    cid,
    "attachments",
    aid + "." + ext,
  );
  atomicWrite(target, data);
  const a = {
    id: aid,
    courseId: cid,
    name: path.basename(file),
    path: target,
    mime,
    ext,
  };
  store.tx((s) => s.attachments.push(a));
  return `attachment:${aid}`;
}
function migrateMarkdown(store, cid, file, body) {
  const missing = [],
    base = fs.realpathSync(path.dirname(file));
  const output = body.replace(
    /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g,
    (whole, alt, angle, plain) => {
      const url = angle || plain;
      if (/^https?:\/\//i.test(url)) return whole;
      try {
        check(
          !/^[a-z]+:|^[\\/]/i.test(url),
          "只迁移 Markdown 同目录内的相对图片",
        );
        const target = path.resolve(base, decodeURIComponent(url));
        check(target.startsWith(base + path.sep), "附件路径超出文档目录");
        const resolved = fs.realpathSync(target);
        check(resolved.startsWith(base + path.sep), "附件实际路径超出文档目录");
        return `![${alt}](${add(store, cid, resolved)})`;
      } catch (e) {
        missing.push({ url, reason: e.message });
        return whole;
      }
    },
  );
  return { body: output, missing };
}
function exportMarkdown(store, body, directory) {
  const missing = [];
  const output = body.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (whole, image, alt, url) => {
      if (/^https?:\/\//.test(url)) return whole;
      if (!image && !url.startsWith("attachment:")) return whole;
      const aid = url.match(/^attachment:([a-f0-9-]+)$/)?.[1];
      const a = store.s.attachments.find((a) => a.id === aid);
      if (!a || !fs.existsSync(a.path)) {
        missing.push(url);
        return whole;
      }
      fs.mkdirSync(path.join(directory, "attachments"), { recursive: true });
      const name = a.id + "." + a.ext;
      fs.copyFileSync(a.path, path.join(directory, "attachments", name));
      return `${image}[${alt}](attachments/${name})`;
    },
  );
  return { body: output, missing };
}
module.exports = { add, migrateMarkdown, exportMarkdown, imageType };
