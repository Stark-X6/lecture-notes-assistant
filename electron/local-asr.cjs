const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { MODELS } = require("./local-asr-models.cjs");
function installed(dir, spec = MODELS.sensevoice) {
  try {
    return (
      spec.files.every(
        (f) => fs.statSync(path.join(dir, f.name)).size === f.size,
      ) && fs.existsSync(path.join(dir, "installed.json"))
    );
  } catch {
    return false;
  }
}
function checksum(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256"),
      s = fs.createReadStream(file);
    s.on("data", (b) => h.update(b));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}
class LocalASR {
  constructor({
    modelRoot,
    modelDir,
    modelId = "sensevoice",
    onChange = () => {},
    fetcher = fetch,
  }) {
    this.modelRoot = path.resolve(modelRoot || path.dirname(modelDir));
    this.legacyDir = modelDir;
    this.modelId = MODELS[modelId] ? modelId : "sensevoice";
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.state = "missing";
    this.progress = 0;
    this.error = null;
    this.child = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
  }
  get spec() {
    return MODELS[this.modelId];
  }
  dirFor(m) {
    return m.id === "sensevoice" && this.legacyDir
      ? path.resolve(this.legacyDir)
      : path.join(this.modelRoot, m.dir);
  }
  get modelDir() {
    return this.dirFor(this.spec);
  }
  status() {
    const ready = installed(this.modelDir, this.spec);
    return {
      modelId: this.modelId,
      models: Object.values(MODELS).map((m) => ({
        id: m.id,
        name: m.name,
        ready: installed(this.dirFor(m), m),
        downloadMB: Math.ceil(m.files.reduce((n, f) => n + f.size, 0) / 1e6),
        modelPage: m.modelPage,
      })),
      modelName: this.spec.name,
      ready,
      modelDir: this.modelDir,
      modelPage: this.spec.modelPage,
      state: ["downloading", "loading", "recognizing", "error"].includes(
        this.state,
      )
        ? this.state
        : ready
          ? "ready"
          : "missing",
      progress: ready ? 100 : this.progress,
      error: this.error,
      queued: this.queued,
    };
  }
  update(state, error = null) {
    this.state = state;
    this.error = error;
    this.onChange();
  }
  select(modelId) {
    if (!MODELS[modelId]) throw new Error("未知本地模型");
    if (this.queued || this.installing || this.starting)
      throw new Error("模型正在下载或识别，请完成后再切换");
    if (this.modelId === modelId) return this.status();
    const old = this.child;
    this.child = null;
    if (old) {
      old.removeAllListeners("exit");
      old.kill();
    }
    this.modelId = modelId;
    this.progress = 0;
    this.update("missing");
    return this.status();
  }
  async install() {
    if (this.installing) return this.installing;
    if (installed(this.modelDir, this.spec)) {
      this.update("ready");
      return this.status();
    }
    this.installing = this.download().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }
  async download() {
    const spec = this.spec,
      staging = this.modelDir + ".download";
    fs.mkdirSync(staging, { recursive: true });
    this.progress = 0;
    this.update("downloading");
    const total = spec.files.reduce((n, f) => n + f.size, 0);
    let finished = 0;
    this.downloadController = new AbortController();
    try {
      for (const file of spec.files) {
        const target = path.join(staging, file.name),
          part = target + ".part";
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (
          fs.existsSync(target) &&
          fs.statSync(target).size === file.size &&
          (await checksum(target)) === file.sha
        ) {
          finished += file.size;
          continue;
        }
        let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (offset > file.size) {
          fs.truncateSync(part, 0);
          offset = 0;
        }
        while (offset < file.size) {
          const end = Math.min(file.size - 1, offset + 8 * 1024 * 1024 - 1);
          let bytes;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const url = `https://modelscope.cn/api/v1/models/${file.repo || spec.repo}/repo?Revision=master&FilePath=${encodeURIComponent(file.name)}&part=${offset}`;
              const res = await this.fetcher(url, {
                headers: { Range: `bytes=${offset}-${end}` },
                signal: AbortSignal.any([
                  this.downloadController.signal,
                  AbortSignal.timeout(60000),
                ]),
              });
              if (!res.ok) throw new Error(`魔搭返回 ${res.status}`);
              bytes = Buffer.from(await res.arrayBuffer());
              if (
                res.status === 200 &&
                offset === 0 &&
                bytes.length === file.size
              )
                break;
              if (res.status !== 206 || bytes.length !== end - offset + 1)
                throw new Error("下载分片大小不符");
              const cr = res.headers.get("content-range");
              if (cr && !cr.startsWith(`bytes ${offset}-${end}/`))
                throw new Error("下载分片范围不符");
              break;
            } catch (e) {
              if (attempt === 2 || this.downloadController.signal.aborted)
                throw e;
            }
          }
          fs.appendFileSync(part, bytes);
          offset += bytes.length;
          const p = Math.min(
            99,
            Math.floor(((finished + offset) / total) * 100),
          );
          if (p !== this.progress) {
            this.progress = p;
            this.onChange();
          }
        }
        if ((await checksum(part)) !== file.sha) {
          fs.unlinkSync(part);
          throw new Error("模型校验失败，请重试下载");
        }
        fs.renameSync(part, target);
        finished += file.size;
      }
      fs.writeFileSync(
        path.join(staging, "installed.json"),
        JSON.stringify(
          {
            model: spec.repo,
            files: spec.files,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      if (fs.existsSync(this.modelDir))
        fs.renameSync(
          this.modelDir,
          this.modelDir + ".incomplete-" + Date.now(),
        );
      fs.renameSync(staging, this.modelDir);
      this.progress = 100;
      this.update("ready");
      return this.status();
    } catch (e) {
      this.update("error", `本地模型下载失败：${e.message}`);
      throw new Error(this.error);
    } finally {
      this.downloadController = null;
    }
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child?.connected) return;
    if (!installed(this.modelDir, this.spec))
      throw new Error("请先在“API 与设置”下载当前本地语音模型");
    this.update("loading");
    this.starting = new Promise((resolve, reject) => {
      const child = fork(
        path.join(__dirname, "local-asr-worker.cjs"),
        [this.modelDir, this.modelId],
        {
          execPath: process.execPath,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      this.child = child;
      let stderr = "",
        ready = false,
        failed = false;
      child.stderr.on("data", (b) => {
        stderr = (stderr + b).slice(-1000);
      });
      const timeout = setTimeout(() => {
        reject(new Error("本地模型加载超时"));
        child.kill();
      }, 180000);
      child.on("message", (m) => {
        if (m.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          this.update("ready");
          resolve();
        } else if (m.type === "fatal") {
          clearTimeout(timeout);
          reject(new Error(m.error));
          child.kill();
        } else if (m.id) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            m.error ? p.reject(new Error(m.error)) : p.resolve(m);
          }
        }
      });
      const fail = (e) => {
        if (failed) return;
        failed = true;
        clearTimeout(timeout);
        if (this.child === child) this.child = null;
        const error = new Error(
          `本地识别进程退出，音频已保留，可补转写。${e?.message || stderr}`,
        );
        if (!ready) reject(error);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(error);
          this.pending.delete(id);
        }
        if (!this.closing) this.update("error", error.message);
      };
      child.once("error", fail);
      child.once("exit", () => fail());
    })
      .catch((e) => {
        this.update("error", e.message);
        throw e;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  transcribe(file, fromMs = 0, toMs = null, options = {}) {
    if (this.queued >= 36)
      return Promise.reject(
        new Error("本地识别积压，音频继续保存，请稍后补转写"),
      );
    this.queued++;
    this.onChange();
    const result = this.queue.then(async () => {
      if (this.closing) throw new Error("本地识别已关闭");
      await this.start();
      this.update("recognizing");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("本地识别超时，音频已保留"));
          this.child?.kill();
        }, 300000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.send(
          {
            id,
            segments: Array.isArray(file) ? file : [{ file, fromMs, toMs }],
            ...options,
          },
          (e) => {
            if (e && this.pending.has(id)) {
              clearTimeout(timer);
              this.pending.delete(id);
              reject(e);
            }
          },
        );
      });
    });
    this.queue = result.catch(() => {});
    return result
      .then(
        (r) => {
          this.update("ready");
          return r;
        },
        (e) => {
          this.update("error", e.message);
          throw e;
        },
      )
      .finally(() => {
        this.queued--;
        this.onChange();
      });
  }
  test() {
    return this.transcribe(path.join(this.modelDir, "test_wavs", "zh.wav"));
  }
  close() {
    this.closing = true;
    this.downloadController?.abort();
    this.child?.kill();
  }
}
module.exports = {
  LocalASR,
  installed,
  MODELS,
  MODEL_PAGE: MODELS.sensevoice.modelPage,
  MODEL_ID: MODELS.sensevoice.repo,
  FILES: MODELS.sensevoice.files,
};
