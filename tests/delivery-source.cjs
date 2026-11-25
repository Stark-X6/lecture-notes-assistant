const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lecture-source-delivery-"));
const python = process.platform === "win32" ? "python" : "python3";
try {
  const fixture = path.join(tmp, "project");
  for (const file of [
    ".gitignore",
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.mjs",
    "README.md",
    "scripts/package-delivery.py",
    "electron/text-settings.cjs",
    "electron/text-providers.json",
  ]) {
    const dest = path.join(fixture, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, file), dest);
  }
  const { build } = require(path.join(fixture, "package.json"));
  const dist = path.join(fixture, build.directories.output, "win-unpacked");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "听课笔记助手.exe"),
    "synthetic packaging fixture",
  );
  fs.writeFileSync(path.join(fixture, "electron", "local-only.json"), "{}");
  execFileSync(python, ["scripts/package-delivery.py"], { cwd: fixture });
  const files = path.join(fixture, "deliverables");
  const zipName = fs.readdirSync(files).find((name) => name.endsWith(".zip"));
  execFileSync(python, ["-m", "zipfile", "-e", path.join(files, zipName), tmp]);
  const unpacked = path.join(tmp, zipName.slice(0, -4));
  const { textTarget } = require(
    path.join(unpacked, "electron", "text-settings.cjs"),
  );
  assert.equal(
    textTarget({ textProvider: "anthropic" }).url,
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    fs.existsSync(path.join(unpacked, "electron", "local-only.json")),
    false,
  );
  console.log(
    "PASS: provider settings load from the extracted source ZIP; local JSON excluded",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
