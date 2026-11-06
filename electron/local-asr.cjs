const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const MODEL_ID = 'WEAAEW/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const MODEL_PAGE = `https://modelscope.cn/models/${MODEL_ID}`;
// Community ONNX mirror of iic/SenseVoiceSmall, pinned to the compatible assets.
const FILES = [
  { name: 'model.int8.onnx', size: 239233841, sha: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  { name: 'tokens.txt', size: 315894, sha: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  { name: 'LICENSE', size: 71, sha: '221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17' },
  { name: 'test_wavs/zh.wav', size: 178988, sha: 'b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373' },
];
function installed(dir) {
  try { return FILES.every(f => fs.statSync(path.join(dir, f.name)).size === f.size) && fs.existsSync(path.join(dir, 'installed.json')); }
  catch { return false; }
}
class LocalASR {
  constructor({ modelDir, onChange = () => {}, fetcher = fetch }) {
    this.modelDir = path.resolve(modelDir); this.onChange = onChange; this.fetcher = fetcher;
    this.state = 'missing'; this.progress = 0; this.error = null;
    this.child = null; this.pending = new Map(); this.queue = Promise.resolve(); this.queued = 0;
  }
  status() {
    const ready = installed(this.modelDir);
    return { modelName: 'SenseVoiceSmall INT8', ready, modelDir: this.modelDir, modelPage: MODEL_PAGE,
      state: ['downloading', 'loading', 'recognizing', 'error'].includes(this.state) ? this.state : ready ? 'ready' : 'missing',
      progress: ready ? 100 : this.progress, error: this.error, queued: this.queued };
  }
  update(state, error = null) { this.state = state; this.error = error; this.onChange(); }
  async install() {
    if (this.installing) return this.installing;
    if (installed(this.modelDir)) { this.update('ready'); return this.status(); }
    this.installing = this.download().finally(() => { this.installing = null; });
    return this.installing;
  }
  async download() {
    const staging = this.modelDir + '.download';
    fs.mkdirSync(staging, { recursive: true });
    this.progress = 0; this.update('downloading');
    const total = FILES.reduce((n, f) => n + f.size, 0);
    let finished = 0;
    this.downloadController = new AbortController();
    try {
      for (const file of FILES) {
        const target = path.join(staging, file.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target) && fs.statSync(target).size === file.size && createHash('sha256').update(fs.readFileSync(target)).digest('hex') === file.sha) {
          finished += file.size; continue;
        }
        const url = `https://modelscope.cn/api/v1/models/${MODEL_ID}/repo?Revision=master&FilePath=${encodeURIComponent(file.name)}`;
        const response = await this.fetcher(url, { signal: AbortSignal.any([this.downloadController.signal, AbortSignal.timeout(15 * 60 * 1000)]) });
        if (!response.ok || !response.body) throw new Error(`魔搭下载失败 (${response.status})`);
        const hash = createHash('sha256');
        let bytes = 0, last = -1;
        const counter = new Transform({ transform: (chunk, _, cb) => {
          bytes += chunk.length;
          if (bytes > file.size) return cb(new Error('模型文件大小异常'));
          hash.update(chunk);
          const p = Math.min(99, Math.floor((finished + bytes) / total * 100));
          if (p !== last) { this.progress = p; last = p; this.onChange(); }
          cb(null, chunk);
        }});
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(target + '.part'));
        if (bytes !== file.size || hash.digest('hex') !== file.sha) throw new Error('模型下载不完整或版本不匹配，请重试');
        fs.renameSync(target + '.part', target); finished += bytes;
      }
      fs.writeFileSync(path.join(staging, 'installed.json'), JSON.stringify({ model: MODEL_ID, files: FILES, installedAt: new Date().toISOString() }, null, 2));
      if (fs.existsSync(this.modelDir)) fs.renameSync(this.modelDir, this.modelDir + '.incomplete-' + Date.now());
      fs.renameSync(staging, this.modelDir);
      this.progress = 100; this.update('ready'); return this.status();
    } catch (e) { this.update('error', `本地模型下载失败：${e.message}`); throw new Error(this.error); }
    finally { this.downloadController = null; }
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child?.connected) return;
    if (!installed(this.modelDir)) throw new Error('请先在“API 与设置”下载本地语音模型');
    this.update('loading');
    this.starting = new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'local-asr-worker.cjs'), [this.modelDir], {
        execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      this.child = child;
      let stderr = '', ready = false, failed = false;
      child.stderr.on('data', b => { stderr = (stderr + b).slice(-1000); });
      const timeout = setTimeout(() => { reject(new Error('本地模型加载超时')); child.kill(); }, 90000);
      child.on('message', m => {
        if (m.type === 'ready') { ready = true; clearTimeout(timeout); this.update('ready'); resolve(); }
        else if (m.type === 'fatal') { clearTimeout(timeout); reject(new Error(m.error)); child.kill(); }
        else if (m.id) {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m); }
        }
      });
      const fail = e => {
        if (failed) return; failed = true; clearTimeout(timeout);
        if (this.child === child) this.child = null;
        const error = new Error(`本地识别进程退出，音频已保留，可补转写。${e?.message || stderr}`);
        if (!ready) reject(error);
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(error); this.pending.delete(id); }
        if (!this.closing) this.update('error', error.message);
      };
      child.once('error', fail); child.once('exit', () => fail());
    }).catch(e => { this.update('error', e.message); throw e; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  transcribe(file, fromMs = 0, toMs = null) {
    if (this.queued >= 36) return Promise.reject(new Error('本地识别积压，音频继续保存，请稍后补转写'));
    this.queued++; this.onChange();
    const result = this.queue.then(async () => {
      if (this.closing) throw new Error('本地识别已关闭');
      await this.start(); this.update('recognizing');
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地识别超时，音频已保留')); this.child?.kill(); }, 90000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.send({ id, file, fromMs, toMs }, e => {
          if (e && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(e); }
        });
      });
    });
    this.queue = result.catch(() => {});
    return result.then(r => { this.update('ready'); return r; }, e => { this.update('error', e.message); throw e; }).finally(() => { this.queued--; this.onChange(); });
  }
  test() { return this.transcribe(path.join(this.modelDir, 'test_wavs', 'zh.wav')); }
  close() { this.closing = true; this.downloadController?.abort(); this.child?.kill(); }
}
module.exports = { LocalASR, installed, MODEL_PAGE, MODEL_ID, FILES };
