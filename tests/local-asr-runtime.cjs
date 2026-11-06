// Exercise the real Electron child process and native addon, including ASAR builds.
const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
(async () => {
  const data = path.resolve(".test-data", "asr-runtime-" + Date.now());
  const application = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    const result = await application.evaluate(async ({ app }, root) => {
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const fs = require("node:fs"),
        path = require("node:path");
      const { LocalASR } = require("./electron/local-asr.cjs");
      const { MODELS } = require("./electron/local-asr-models.cjs");
      // Qwen loads weights only on recognition. Sparse fixture files pass the
      // installation gate; the worker must actually load the native addon.
      const modelRoot = path.join(root, "native-load-fixture");
      const dir = path.join(modelRoot, MODELS.qwen3.dir);
      for (const file of MODELS.qwen3.files) {
        const target = path.join(dir, file.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(target, "w");
        fs.ftruncateSync(fd, file.size);
        fs.closeSync(fd);
      }
      fs.writeFileSync(path.join(dir, "installed.json"), "{}");
      const local = new LocalASR({ modelRoot, modelId: "qwen3" });
      try {
        await local.start();
        return {
          connected: local.child.connected,
          state: local.status().state,
        };
      } finally {
        local.close();
        fs.rmSync(modelRoot, { recursive: true, force: true });
      }
    }, data);
    assert.equal(result.connected, true);
    assert.equal(result.state, "ready");
    console.log(
      "PASS: native ASR addon loads in the real Electron inference worker",
    );
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
