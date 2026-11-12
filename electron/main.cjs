const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  systemPreferences,
  session,
  shell,
} = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  { Worker } = require("node:worker_threads");
const {
  Store,
  id,
  hash,
  clone,
  check,
  text,
  atomicWrite,
  parseSrt,
  DEFAULT_TEMPLATE,
} = require("./core.cjs");
const { Scheduler, endpoint, generate } = require("./provider.cjs");
const {
  MIN_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
} = require("./generation-limits.cjs");
const { ensureMicrophonePermission } = require("./platform.cjs");
const { LiveASR } = require("./asr.cjs");
const { LocalASR } = require("./local-asr.cjs");
const {
  plan: planLocal,
  consume: consumeLocal,
} = require("./local-asr-segments.cjs");
const localForces = new Set();
let localAsr;
const localRuns = new Map();

const { TingwuASR } = require("./tingwu-asr.cjs");
const { TingwuAPI } = require("./tingwu-api.cjs");
const { replayTingwu } = require("./tingwu-backfill.cjs");
let store,
  win,
  scheduler,
  record = null,
  quitting = false,
  broadcastTimer;
let recordingStartVersion = 0;
let recordingBusy = false,
  stoppingRecording = null,
  tingwuTestRun = null,
  configuring = false;
let shutdownPending = false,
  shutdownReady = false;
const captureAcks = new Map();
const backfills = new Map();
const backfillTasks = new Map();
async function recordingAction(fn) {
  check(
    !recordingBusy && !configuring && !tingwuTestRun,
    "正在处理录音或 API 设置，请稍候",
  );
  recordingBusy = true;
  try {
    return await fn();
  } finally {
    recordingBusy = false;
  }
}
async function cancelBackfills(lids = [...backfills.keys()]) {
  for (const lid of lids) backfills.get(lid)?.abort();
  await Promise.allSettled(
    lids.map((lid) => backfillTasks.get(lid) || localRuns.get(lid)),
  );
}
const root =
  process.env.LECTURE_DATA_DIR || path.join(app.getPath("userData"), "library");
if (process.env.LECTURE_DATA_DIR) {
  const profile = path.join(path.resolve(root), "electron-profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
if (!app.requestSingleInstanceLock()) app.quit();
function emit(event) {
  if (win && !win.isDestroyed()) win.webContents.send("app:event", event);
}
function broadcast() {
  if (!broadcastTimer)
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      emit({ type: "changed" });
    }, 150);
}
function key(kind) {
  const secret = store.s.secrets[kind];
  return secret ? safeStorage.decryptString(Buffer.from(secret, "base64")) : "";
}
function tingwuCredentials() {
  return { accessKeyId: key("tingwuId"), accessKeySecret: key("tingwuSecret") };
}
function createASR(lid) {
  if (store.s.config.asrBackend === "local")
    return { frame() {}, commit() {}, disconnect() {}, stop() {}, pause() {} };
  const partial = (text) => emit({ type: "partial", lessonId: lid, text });
  const warning = (message) => emit({ type: "warning", message });
  if (
    store.s.config.mode === "http" &&
    store.s.config.asrProvider === "tingwu"
  ) {
    try {
      return new TingwuASR(store, lid, tingwuCredentials(), partial, warning);
    } catch {
      warning("听悟凭据不可用，请在 API 设置中重新填写；录音仍保存在本机");
      return {
        frame() {},
        commit() {},
        disconnect() {},
        stop() {},
        pause() {},
      };
    }
  }
  return new LiveASR(store, lid, key("asr"), partial, warning);
}
async function finishPendingTingwu() {
  const pending = store.s.streams.filter(
    (s) =>
      s.provider === "tingwu" &&
      s.cloudTaskId &&
      !["stopped", "failed"].includes(s.cloudState),
  );
  if (!pending.length) return { count: 0 };
  check(
    !record && !backfills.size && !tingwuTestRun && !configuring,
    "请先停止录音和补转写，再结束遗留任务",
  );
  const api = new TingwuAPI(tingwuCredentials());
  let count = 0;
  for (const stream of pending) {
    const info = await api.info(stream.cloudTaskId);
    if (!["COMPLETED", "FAILED", "INVALID"].includes(info?.taskStatus))
      await api.stop(stream.cloudTaskId);
    store.tx(() => {
      stream.cloudState = "stopped";
    });
    count++;
  }
  return { count };
}
function ensureConsent(lid, kind) {
  const l = store.lesson(lid),
    c = store.course(l.courseId);
  check(!l.aiPaused, "AI 已暂停");
  check(
    c.consent[kind] && c.consent.version === store.s.config.version,
    "请先授权本课向当前服务发送相应数据",
  );
  return l;
}
function reserve(l) {
  check(l.calls < store.s.config.maxCalls, "已达到本课调用上限");
  store.tx(() => l.calls++);
}
function assetPath(cid, filename) {
  store.course(cid);
  return path.join(root, "courses", cid, "materials", filename);
}
function recoverAudio() {
  for (const l of store.s.lessons) {
    const dir = path.join(root, "lessons", l.id, "audio");
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(/^(\d+)-(\d+)-(\d+)\.wav$/);
      if (
        !m ||
        store.s.chunks.some((c) => c.lessonId === l.id && c.seq === +m[1])
      )
        continue;
      const p = path.join(dir, file),
        data = fs.readFileSync(p);
      if (data.length >= 44 && data.toString("ascii", 0, 4) === "RIFF")
        store.tx((s) => {
          s.chunks.push({
            id: id(),
            lessonId: l.id,
            seq: +m[1],
            startMs: +m[2],
            endMs: +m[3],
            path: p,
            checksum: hash([...data]),
            recovered: true,
          });
          l.captureMs = Math.max(l.captureMs, +m[3]);
        });
    }
  }
}
function command(type) {
  return new Promise((resolve, reject) => {
    const rid = id();
    const timeout = setTimeout(() => {
      captureAcks.delete(rid);
      reject(new Error("录音设备无响应"));
    }, 8000);
    captureAcks.set(rid, { resolve, reject, timeout });
    record.window.webContents.send("capture:command", { type, id: rid });
  });
}
function flushAudio() {
  return new Promise((resolve, reject) => {
    const rid = id();
    const timer = setTimeout(() => {
      record?.worker.off("message", onMessage);
      reject(new Error("音频写盘确认超时"));
    }, 5000);
    const onMessage = (m) => {
      if (m.type === "flushed" && m.requestId === rid) {
        clearTimeout(timer);
        record?.worker.off("message", onMessage);
        resolve();
      }
    };
    record.worker.on("message", onMessage);
    record.worker.postMessage({ type: "flush", requestId: rid });
  });
}
async function startRecording(lid) {
  check(!record, "已有录音正在进行");
  if (store.s.config.asrBackend === "local")
    check(localAsr.status().ready, "请先在 API 与设置中下载当前本地语音模型");
  check(!backfills.has(lid), "请等待本课补转写结束");
  store.lesson(lid);
  const owner = win,
    startVersion = recordingStartVersion;
  await ensureMicrophonePermission(
    systemPreferences,
    app.isPackaged ? app.getName() : "Electron（开发运行）",
  );
  check(
    startVersion === recordingStartVersion &&
      !shutdownPending &&
      !quitting &&
      win === owner &&
      owner &&
      !owner.isDestroyed(),
    "录音启动已取消，请重新打开课堂后再试",
  );
  const l = store.lesson(lid);
  check(!l.deleted, "课堂已删除，录音启动已取消");
  if (!Number.isInteger(l.captureMs))
    store.tx(() => (l.captureMs = Math.round(l.captureMs)));
  check(!backfills.has(lid), "请等待本课补转写结束");
  const worker = new Worker(path.join(__dirname, "audio-worker.cjs"), {
    workerData: {
      dir: path.join(root, "lessons", lid, "audio"),
      startMs: l.captureMs,
      seq: Math.max(
        0,
        ...store.s.chunks
          .filter((c) => c.lessonId === lid)
          .map((c) => c.seq + 1),
      ),
    },
  });
  const recorder = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "recorder-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  record = {
    lid,
    window: recorder,
    worker,
    ms: l.captureMs,
    originMs: l.captureMs,
    samples: 0,
    asr: createASR(lid),
  };
  record.lastWriteAt = Date.now();
  record.persistedMs = l.captureMs;
  record.watchdog = setInterval(() => {
    if (
      record?.lid === lid &&
      require("./capture-health.cjs").writeStalled(
        Date.now(),
        record.lastWriteAt,
        record.ms,
        record.persistedMs,
      )
    ) {
      l.captureError = "音频写盘确认超过15秒，已停止采集";
      void stopRecording().catch((e) =>
        emit({ type: "warning", message: e.message }),
      );
    }
  }, 1000);
  worker.on("message", (m) => {
    if (m.type === "chunk") {
      if (record?.lid === lid) {
        record.lastWriteAt = Date.now();
        record.persistedMs = m.endMs;
      }
      try {
        store.tx((s) => {
          s.chunks.push({ id: id(), lessonId: lid, ...m });
          l.captureMs = m.endMs;
        });
        autoSubmit(lid);
        if (store.s.config.asrBackend === "local" && !l.aiPaused)
          void localBackfill(lid, { force: false }).catch((e) =>
            emit({ type: "warning", message: e.message }),
          );
      } catch (e) {
        emit({ type: "warning", message: e.message });
        stopRecording().catch(() => {});
      }
    }
    if (m.type === "error") {
      l.captureError = m.message;
      emit({ type: "warning", message: m.message });
      stopRecording().catch(() => {});
    }
  });
  worker.on("error", () => {
    l.captureError = "录音保存进程异常";
    emit({ type: "warning", message: "录音保存进程异常，已停止采集" });
    stopRecording().catch(() => {});
  });
  await recorder.loadFile(path.join(__dirname, "recorder.html"));
  try {
    await command("start");
    store.tx(() => {
      l.recording = "recording";
      l.recovered = false;
      l.writeComplete = false;
      l.asrFinalized = false;
      l.autoPending = false;
      l.captureError = null;
    });
  } catch (e) {
    await record?.asr.disconnect();
    clearInterval(record?.watchdog);
    worker.terminate();
    recorder.destroy();
    record = null;
    throw e;
  }
}
function stopRecording() {
  if (!stoppingRecording)
    stoppingRecording = stopRecordingImpl().finally(() => {
      stoppingRecording = null;
    });
  return stoppingRecording;
}
async function stopRecordingImpl() {
  if (!record) return;
  const current = record,
    l = store.lesson(current.lid);
  let failure;
  try {
    await command("stop");
    await flushAudio();
    store.tx(() => (l.writeComplete = true));
    await current.asr.stop();
    store.tx(() => (l.asrFinalized = true));
  } catch (e) {
    failure = e;
  } finally {
    clearInterval(current.watchdog);
    current.worker.postMessage({ type: "stop" });
    const termination = setTimeout(() => current.worker.terminate(), 5000);
    termination.unref();
    current.worker.once("exit", () => clearTimeout(termination));
    if (!current.window.isDestroyed()) current.window.destroy();
    record = null;
    store.tx(() => {
      l.recording = "stopped";
      l.captureMs = current.ms;
      l.captureError = failure?.message || l.captureError;
      l.autoPending = true;
    });
  }
  if (failure) {
    emit({
      type: "warning",
      message: failure.message + "；已停止采集，课堂标记为待补齐",
    });
    return;
  }
  if (store.s.config.asrBackend === "local" && !l.aiPaused)
    void localBackfill(l.id).catch((e) =>
      emit({ type: "warning", message: e.message }),
    );
  autoSubmit(l.id, true);
}
function autoSubmit(lid, tail = false) {
  const l = store.lesson(lid);
  if (l.aiPaused || store.s.config.mode === "off") return;
  const end = l.captureMs;
  if (l.deleted) return;
  if (
    l.mode === "auto" &&
    l.autoAfterStop &&
    l.autoPending &&
    l.recording === "stopped" &&
    !backfills.has(lid) &&
    store.readiness(lid).complete
  ) {
    try {
      store.maybeWhole(lid);
    } catch (e) {
      if (l.autoError !== e.message) store.tx(() => (l.autoError = e.message));
    }
  }
  for (const w of l.windows.filter((w) => w.state === "waiting")) {
    const coverage = store.s.streams
      .filter((s) => s.lessonId === lid)
      .flatMap((s) => s.confirmed)
      .sort((a, b) => a.startMs - b.startMs);
    let cursor = w.start;
    for (const r of coverage) {
      if (r.startMs <= cursor + 120) cursor = Math.max(cursor, r.endMs);
    }
    if (cursor < w.end - 120) continue;
    const us = store.s.utterances.filter(
      (u) => u.lessonId === lid && u.endMs > w.start && u.startMs < w.end,
    );
    if (us.some((u) => u.needsReview)) continue;
    try {
      if (us.length)
        store.enqueue(lid, {
          uids: us.map((u) => u.id),
          context: w.context,
          template: w.template,
          prompt: w.prompt || "",
          submittedAt: w.submittedAt,
          baseline: w.baseline,
          noteId: w.noteId,
        });
      store.tx(() => (w.state = us.length ? "submitted" : "silence"));
    } catch (e) {
      if (
        e.message.includes("没有新的") ||
        e.message.includes("选定范围没有内容")
      )
        store.tx(() => (w.state = "submitted"));
    }
  }
}
function localBackfill(lid, { force = true } = {}) {
  if (force) localForces.add(lid);
  if (localRuns.has(lid)) return localRuns.get(lid);
  const operation = runLocalBackfill(lid).finally(() => {
    localRuns.delete(lid);
    localForces.delete(lid);
  });
  localRuns.set(lid, operation);
  return operation;
}
async function runLocalBackfill(lid) {
  check(!backfills.has(lid), "该课转写正在进行");
  check(localAsr.status().ready, "请先下载当前本地语音模型");
  const l = store.lesson(lid),
    version = store.s.config.version,
    modelId = localAsr.modelId;
  const hotwords = store.course(l.courseId).asrTerms || "";
  const controller = new AbortController();
  backfills.set(lid, controller);
  const allowed = () => {
    store.lesson(lid);
    check(
      !controller.signal.aborted &&
        !l.aiPaused &&
        store.s.config.asrBackend === "local" &&
        version === store.s.config.version &&
        modelId === localAsr.modelId,
      "本地转写已停止，音频保留，可稍后补转写",
    );
  };
  let count = 0;
  try {
    while (true) {
      allowed();
      const chunks = store.s.chunks.filter((c) => c.lessonId === lid);
      const ranges = store.s.streams
        .filter((s) => s.lessonId === lid)
        .flatMap((s) => s.confirmed);
      const batch = planLocal(chunks, ranges);
      if (!batch.parts.length) break;
      const force = localForces.has(lid) || l.recording !== "recording";
      // Hold a live short tail to collect context; stop/pause/manual backfill flush it.
      const latest = Math.max(...chunks.map((c) => c.endMs));
      if (
        !force &&
        batch.duration < 19999 &&
        batch.parts.at(-1).end >= latest - 2
      )
        break;
      const result = await localAsr.transcribe(
        batch.parts.map((p) => ({
          file: p.chunk.path,
          fromMs: p.start - p.chunk.startMs,
          toMs: p.end - p.chunk.startMs,
        })),
        0,
        null,
        { hotwords, preferPause: batch.duration >= 19999 },
      );
      allowed();
      const used = consumeLocal(
        batch.parts,
        Math.min(batch.duration, result.consumedMs || batch.duration),
      );
      check(used.length > 0, "识别没有消耗音频");
      const start = used[0].start,
        end = used.at(-1).end,
        provider = "local-" + modelId;
      store.tx((s) => {
        if (result.text.trim())
          s.utterances.push({
            id: id(),
            lessonId: lid,
            text: result.text,
            revision: 1,
            history: [],
            startMs: start,
            endMs: end,
            timing: "chunk-range",
            chunkId: used[0].chunk.id,
            chunkIds: [...new Set(used.map((p) => p.chunk.id))],
            final: true,
            topicId: null,
            createdAt: Date.now(),
            provider,
            needsReview: !!result.needsReview,
            reviewReason: result.reviewReason || null,
          });
        const confirmed = used.map((p) => ({ startMs: p.start, endMs: p.end }));
        s.streams.push({
          id: id(),
          lessonId: lid,
          originMs: start,
          confirmed,
          recovery: true,
          provider,
        });
        const allRanges = ranges.concat(confirmed);
        for (const c of chunks)
          if (!planLocal([c], allRanges).parts.length) c.transcribed = true;
      });
      count++;
      autoSubmit(lid, l.recording === "stopped");
    }
    return { count, provider: "local", modelId };
  } finally {
    backfills.delete(lid);
  }
}
async function backfillTingwu(lid) {
  check(record?.lid !== lid, "请先停止本课录音，再补转写");
  const l = ensureConsent(lid, "audio");
  const controller = new AbortController();
  backfills.set(lid, controller);
  emit({
    type: "warning",
    message: "听悟补转写按音频时长推流，请保持应用打开",
  });
  try {
    const result = await replayTingwu(store, lid, tingwuCredentials(), {
      signal: controller.signal,
      onPartial: (text) => emit({ type: "partial", lessonId: lid, text }),
      onError: (message) => emit({ type: "warning", message }),
      ensureAllowed: () => ensureConsent(lid, "audio"),
      reserve: () => reserve(l),
    });
    autoSubmit(lid, true);
    return result;
  } finally {
    backfills.delete(lid);
  }
}
async function backfill(lid) {
  check(!backfills.has(lid), "补转写正在进行");
  const l = ensureConsent(lid, "audio"),
    cfg = clone(store.s.config);
  check(cfg.mode === "http", "请先选择真实 API 并保存语音配置");
  if (cfg.asrProvider === "tingwu") return backfillTingwu(lid);
  check(cfg.mode === "http" && cfg.fileModel, "请配置文件转写模型");
  const secret = key("asr");
  check(secret, "请填写语音 API 密钥");
  const controller = new AbortController();
  backfills.set(lid, controller);
  let count = 0;
  try {
    const chunks = store.s.chunks.filter(
      (c) => c.lessonId === lid && !c.transcribed,
    );
    for (const c of chunks) {
      ensureConsent(lid, "audio");
      if (controller.signal.aborted) break;
      const ranges = store.s.streams
        .filter((s) => s.lessonId === lid)
        .flatMap((s) => s.confirmed);
      let gaps = [{ start: c.startMs, end: c.endMs }];
      for (const r of ranges)
        gaps = gaps.flatMap((g) =>
          r.endMs <= g.start || r.startMs >= g.end
            ? [g]
            : [
                { start: g.start, end: Math.min(g.end, r.startMs) },
                { start: Math.max(g.start, r.endMs), end: g.end },
              ].filter((x) => x.end - x.start > 80),
        );
      for (const gap of gaps) {
        reserve(l);
        const data = fs.readFileSync(c.path);
        const start = Math.round((gap.start - c.startMs) * 24) * 2,
          end = Math.round((gap.end - c.startMs) * 24) * 2;
        const pcm = data.subarray(44 + start, 44 + end),
          wav = Buffer.concat([data.subarray(0, 44), pcm]);
        wav.writeUInt32LE(36 + pcm.length, 4);
        wav.writeUInt32LE(pcm.length, 40);
        const form = new FormData();
        form.append(
          "file",
          new Blob([wav], { type: "audio/wav" }),
          "recovery.wav",
        );
        form.append("model", cfg.fileModel);
        const response = await fetch(endpoint(cfg.fileUrl), {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${secret}` },
          body: form,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        });
        check(response.ok, `补转写失败 (${response.status})，已保留音频`);
        const result = await response.json();
        ensureConsent(lid, "audio");
        if (controller.signal.aborted) break;
        store.tx((s) => {
          if (result.text?.trim())
            s.utterances.push({
              id: id(),
              lessonId: lid,
              text: result.text,
              revision: 1,
              history: [],
              startMs: gap.start,
              endMs: gap.end,
              timing: "chunk-range",
              chunkId: c.id,
              final: true,
              topicId: null,
              createdAt: Date.now(),
            });
          s.streams.push({
            id: id(),
            lessonId: lid,
            originMs: gap.start,
            confirmed: [{ startMs: gap.start, endMs: gap.end }],
            recovery: true,
          });
        });
        count++;
      }
      if (!controller.signal.aborted) store.tx(() => (c.transcribed = true));
    }
    autoSubmit(lid, l.recording === "stopped");
    return { count };
  } finally {
    backfills.delete(lid);
  }
}
async function importMaterial(a) {
  const l = a.lessonId
    ? store.lesson(a.lessonId)
    : { courseId: store.course(a.courseId).id };
  const result = await dialog.showOpenDialog(win, {
    title: "导入课件、教材或转录",
    properties: ["openFile"],
    filters: [{ name: "课程资料", extensions: ["pdf", "txt", "srt", "md"] }],
  });
  if (result.canceled) return null;
  const file = result.filePaths[0],
    ext = path.extname(file).toLowerCase(),
    stat = fs.statSync(file);
  check(stat.size <= 100 * 1024 * 1024, "文件不能超过 100 MB");
  const data = fs.readFileSync(file),
    sha = hash([...data]);
  const existing = store.s.materials.find(
    (m) => m.courseId === l.courseId && m.sha === sha,
  );
  if (existing && ext === ".pdf") return existing;
  const mid = id(),
    target = assetPath(l.courseId, mid + ext);
  if (ext === ".pdf")
    check(data.subarray(0, 5).toString() === "%PDF-", "文件不是有效 PDF");
  atomicWrite(target, data);
  let body = [".txt", ".srt", ".md"].includes(ext)
    ? data.toString("utf8").replace(/^\uFEFF/, "")
    : "";
  if (ext === ".srt" && l.id) {
    const entries = parseSrt(body);
    for (const e of entries) {
      const { text: body, ...timing } = e;
      for (let offset = 0; offset < body.length; offset += 18000)
        store.addUtterance(l.id, body.slice(offset, offset + 18000), timing);
    }
  }
  if (ext === ".txt" && l.id)
    for (const paragraph of body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()))
      for (let offset = 0; offset < paragraph.length; offset += 18000)
        store.addUtterance(l.id, paragraph.slice(offset, offset + 18000));
  if (ext === ".md") {
    const migrated = require("./attachments.cjs").migrateMarkdown(
      store,
      l.courseId,
      file,
      body,
    );
    body = migrated.body;
    if (migrated.missing.length)
      emit({
        type: "warning",
        message:
          "缺失或未迁移图片：" + migrated.missing.map((x) => x.url).join("、"),
      });
    const notebook = l.id
      ? null
      : store.newNotebook(l.courseId, path.basename(file, ext));
    const t = l.id
      ? store.topic(l.id, path.basename(file, ext))
      : routes["note.create"]({
          noteId: notebook.id,
          title: path.basename(file, ext),
        });
    store.saveNote(t.id, 0, body, true);
  }
  const m = {
    id: mid,
    courseId: l.courseId,
    name: path.basename(file),
    kind: a.kind || "slides",
    ext,
    sha,
    path: target,
    pages: body ? [body] : [],
    createdAt: Date.now(),
  };
  store.tx((s) => {
    s.materials.push(m);
    if (l.id && [".txt", ".srt"].includes(ext)) {
      l.importedAt = Date.now();
      l.importedComplete = true;
    }
  });
  return { ...m, path: undefined };
}
async function exportNotes(lid) {
  const l = store.lesson(lid),
    c = store.course(l.courseId);
  const notebook = store.s.notebooks.find((n) => n.id === l.noteId);
  const topics = clone(store.lessonTopics(lid));
  const result = await dialog.showOpenDialog(win, {
    title: "选择导出目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return null;
  const name = (c.name + "-" + l.name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 80);
  const target = path.join(result.filePaths[0], name + "-" + Date.now());
  const temp = target + ".tmp";
  fs.mkdirSync(temp, { recursive: true });
  let body = `# ${notebook.name}\n\n`;
  const footnotes = new Map();
  for (const t of topics) {
    const exported = require("./attachments.cjs").exportMarkdown(
      store,
      t.body,
      temp,
    );
    body += `## ${t.title}\n\n${exported.body}\n\n`;
    if (exported.missing.length)
      body += "> 缺失附件：" + exported.missing.join("、") + "\n\n";
    if (t.sources.length) {
      body += "来源：\n";
      for (const r of t.sources) {
        const label =
          r.kind === "material"
            ? `${r.name}，第 ${r.page} 页`
            : r.startMs === null
              ? `转录第 ${r.paragraph} 段`
              : `转录 ${Math.round(r.startMs / 1000)}–${Math.round(r.endMs / 1000)} 秒`;
        const description =
          r.kind === "transcript" && r.lessonName
            ? `${r.lessonName} · ${label}`
            : label;
        if (!footnotes.has(r.id)) {
          const key = `source-${footnotes.size + 1}`;
          const excerpt = (r.text || "").trim();
          const definition =
            `[^${key}]: ${description}` +
            (excerpt
              ? "\n\n" +
                excerpt
                  .split(/\r?\n/)
                  .map((line) => "    " + line)
                  .join("\n")
              : "");
          footnotes.set(r.id, { key, definition });
        }
        body += `- ${description} [^${footnotes.get(r.id).key}]\n`;
      }
      body += "\n";
    }
  }
  if (footnotes.size)
    body +=
      [...footnotes.values()].map((r) => r.definition).join("\n\n") + "\n";
  fs.writeFileSync(path.join(temp, "notes.md"), body, "utf8");
  fs.writeFileSync(
    path.join(temp, "manifest.json"),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        course: c.name,
        lesson: l.name,
        versions: topics.map((t) => ({ topicId: t.id, version: t.version })),
        sources: footnotes.size,
      },
      null,
      2,
    ),
  );
  fs.renameSync(temp, target);
  shell.showItemInFolder(path.join(target, "notes.md"));
  return target;
}
const routes = {
  "audio.store": async (a) => {
    const l = store.lesson(a.lessonId);
    check(!record, "请先结束当前录音");
    const pcm = Buffer.from(a.pcm);
    check(
      pcm.length > 0 && pcm.length <= 600 * 1024 * 1024 && pcm.length % 2 === 0,
      "PCM 音频无效或过大",
    );
    const dir = path.join(root, "lessons", l.id, "audio");
    let seq = Math.max(
        0,
        ...store.s.chunks
          .filter((c) => c.lessonId === l.id)
          .map((c) => c.seq + 1),
      ),
      start = l.captureMs;
    for (let pos = 0; pos < pcm.length;) {
      // Keep an imported short tail with its preceding phrase, up to 6 seconds.
      const size = pcm.length - pos < 288000 ? pcm.length - pos : 240000;
      const part = pcm.subarray(pos, pos + size),
        end = start + part.length / 48,
        wav = Buffer.alloc(44 + part.length);
      wav.write("RIFF");
      wav.writeUInt32LE(36 + part.length, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24);
      wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(part.length, 40);
      part.copy(wav, 44);
      const file = path.join(
        dir,
        `${seq}-${Math.round(start)}-${Math.round(end)}.wav`,
      );
      atomicWrite(file, wav);
      store.tx((s) => {
        s.chunks.push({
          id: id(),
          lessonId: l.id,
          seq,
          startMs: Math.round(start),
          endMs: Math.round(end),
          path: file,
          checksum: hash([...wav]),
        });
        l.captureMs = end;
      });
      seq++;
      pos += part.length;
      start = end;
      await new Promise((r) => setImmediate(r));
    }
    if (store.s.config.asrBackend === "local" && !l.aiPaused)
      void localBackfill(l.id).catch((e) =>
        emit({ type: "warning", message: e.message }),
      );
    return { durationMs: l.captureMs };
  },
  snapshot: () => ({ ...store.snapshot(), localAsr: localAsr.status() }),
  "localAsr.status": () => localAsr.status(),
  "localAsr.install": () => localAsr.install(),
  "localAsr.test": () => localAsr.test(),
  "localAsr.openModelPage": () =>
    shell.openExternal(localAsr.status().modelPage),
  "localAsr.select": (a) => {
    check(
      !record && !backfills.size && !configuring && !tingwuTestRun,
      "请先结束录音和转写再切换模型",
    );
    const status = localAsr.select(a.modelId);
    store.tx((s) => {
      s.config.localAsrModel = a.modelId;
    });
    return status;
  },
  "localAsr.terms": (a) => {
    const c = store.course(a.courseId || store.lesson(a.lessonId).courseId);
    check(!backfills.size, "请待当前转写完成或暂停后保存术语");
    const raw = text(a.terms, 1000).trim();
    const terms = raw
      .split(/[，,、;；\r\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    check(terms.length <= 80, "课程术语最多 80 个");
    store.tx(() => {
      c.asrTerms = [...new Set(terms)].join(",");
    });
    return { terms: c.asrTerms };
  },
  "localAsr.openFolder": () => {
    fs.mkdirSync(localAsr.modelDir, { recursive: true });
    return shell.openPath(localAsr.modelDir);
  },
  "localAsr.configure": (a) => {
    check(["local", "cloud"].includes(a.backend), "语音识别模式无效");
    check(
      !record && !recordingBusy && !configuring && !tingwuTestRun,
      "请先结束录音或当前 API 操作再切换识别方式",
    );
    check(!backfills.size, "请先停止或等待当前转写完成再切换识别方式");
    store.tx((s) => {
      s.config.asrBackend = a.backend;
    });
    return localAsr.status();
  },
  "audio.retranscribe": (a) => {
    const isLocal = store.s.config.asrBackend === "local";
    check(
      !configuring && !tingwuTestRun && !recordingBusy,
      "请先完成当前设置或录音操作",
    );
    if (isLocal) check(localAsr.status().ready, "请先下载当前模型");
    else {
      ensureConsent(a.lessonId, "audio");
      check(store.s.config.mode === "http", "请先保存真实 API 配置");
      if (store.s.config.asrProvider === "tingwu") {
        check(store.s.config.tingwuAppKey, "请先配置听悟项目");
        new TingwuAPI(tingwuCredentials());
      } else {
        check(
          store.s.config.fileModel && key("asr"),
          "请先配置文件转写模型和语音密钥",
        );
      }
    }
    check(!record && !backfills.has(a.lessonId), "请先结束录音和当前转写");
    const source = store.lesson(a.lessonId),
      chunks = store.s.chunks
        .filter((c) => c.lessonId === source.id)
        .sort((a, b) => a.seq - b.seq);
    check(chunks.length > 0, "本课没有可重新转写的原录音");
    for (const c of chunks)
      check(fs.existsSync(c.path), "原录音文件缺失，无法重新转写");
    const newId = id(),
      dir = path.join(root, "lessons", newId, "audio");
    fs.mkdirSync(dir, { recursive: true });
    let copies;
    try {
      copies = chunks.map((c) => {
        const target = path.join(
          dir,
          c.seq + "-" + c.startMs + "-" + c.endMs + ".wav",
        );
        fs.copyFileSync(c.path, target);
        return {
          ...c,
          id: id(),
          lessonId: newId,
          path: target,
          transcribed: false,
        };
      });
      store.tx((s) => {
        s.lessons.push({
          id: newId,
          courseId: source.courseId,
          name: source.name.slice(0, 100) + " · 重新转写",
          mode: "semi",
          recording: "stopped",
          captureMs: source.captureMs,
          submittedMs: 0,
          windows: [],
          aiPaused: false,
          createdAt: Date.now(),
          context: clone(source.context),
          calls: 0,
          sourceLessonId: source.id,
        });
        s.chunks.push(...copies);
      });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const operation = isLocal ? localBackfill(newId) : backfill(newId);
    backfillTasks.set(newId, operation);
    void operation
      .catch((e) => emit({ type: "warning", message: e.message }))
      .finally(() => backfillTasks.delete(newId));
    return { lessonId: newId };
  },

  "course.create": (a) => store.createCourse(a.name),
  "lesson.create": (a) => store.createLesson(a.courseId, a.name, a),
  "lesson.mode": (a) => {
    const l = store.lesson(a.lessonId);
    check(["auto", "semi"].includes(a.mode));
    store.tx(() => {
      l.mode = a.mode;
      store.event(l.id, "mode.changed", { mode: a.mode });
    });
  },
  "lesson.context": (a) => store.setContext(a.lessonId, a.context),
  "lesson.consent": async (a) => {
    const c = store.course(a.courseId || store.lesson(a.lessonId).courseId);
    store.tx(() => {
      c.consent = {
        text: !!a.text,
        audio: !!a.audio,
        version: store.s.config.version,
      };
    });
    if (!a.text)
      for (const t of store.s.tasks.filter(
        (t) =>
          (t.courseId ||
            store.s.lessons.find((l) => l.id === t.lessonId)?.courseId) ===
            c.id && ["queued", "running"].includes(t.state),
      ))
        scheduler.cancel(t.id);
    if (!a.audio && store.s.config.asrBackend !== "local") {
      await record?.asr.disconnect();
      for (const lesson of store.s.lessons.filter((l) => l.courseId === c.id))
        backfills.get(lesson.id)?.abort();
    }
  },
  "topic.create": (a) => store.topic(a.lessonId, a.title),
  "topic.assign": (a) => store.assign(a.lessonId, a.ids, a.topicId),
  "note.save": (a) => store.saveNote(a.topicId, a.version, a.body),
  "note.restore": (a) => store.restore(a.revisionId, a.version),
  "note.export": (a) => exportNotes(a.lessonId),
  "candidate.apply": (a) => store.candidate(a.id, true, a.version),
  "candidate.reject": (a) => store.candidate(a.id, false),
  "transcript.add": (a) => store.addUtterance(a.lessonId, text(a.text)),
  "transcript.revise": (a) => store.revise(a.id, a.revision, a.text),
  "submission.create": (a) => {
    const l = store.lesson(a.lessonId);
    if (a.all)
      return store.enqueueWhole(l.id, {
        prompt: a.prompt,
        allowIncomplete: a.allowIncomplete,
      });
    check(
      l.mode === "semi",
      "自动模式在结束后整理整课；如需课堂分段请切换半自动",
    );
    if (record?.lid === l.id && !a.all && !a.uids) {
      record.asr.commit();
      const cut = record.ms,
        last = Math.max(0, ...l.windows.map((w) => w.end));
      if (cut > last) {
        const w = {
          start: last,
          end: cut,
          state: "waiting",
          context: clone(l.context),
          template: clone(store.course(l.courseId).template),
          baseline: clone(store.lessonTopics(l.id)),
          noteId: l.noteId,
          prompt: text(a.prompt || "", 4000),
          submittedAt: Date.now(),
        };
        store.tx(() => l.windows.push(w));
        autoSubmit(l.id);
        return { waiting: true, end: cut };
      }
      const waiting = l.windows.find(
        (w) => w.end === cut && w.state === "waiting",
      );
      if (waiting) return { waiting: true, end: cut };
    }
    return store.enqueue(a.lessonId, {
      all: !!a.all,
      uids: a.uids,
      prompt: a.prompt,
    });
  },
  "task.retry": (a) => scheduler.retry(a.id),
  "task.cancel": (a) => scheduler.cancel(a.id),
  "ai.pause": async (a) => {
    const l = store.lesson(a.lessonId);
    store.tx(() => (l.aiPaused = !!a.paused));
    if (a.paused) {
      for (const t of store.s.tasks.filter(
        (t) => t.lessonId === l.id && ["running", "queued"].includes(t.state),
      ))
        scheduler.cancel(t.id);
      if (record?.lid === l.id) await record.asr.disconnect();
      backfills.get(l.id)?.abort();
    }
  },
  "material.import": importMaterial,
  "material.read": (a) => {
    const m = store.s.materials.find((m) => m.id === a.id);
    check(m);
    store.course(m.courseId);
    return fs.readFileSync(m.path);
  },
  "material.index": (a) => {
    const m = store.s.materials.find((m) => m.id === a.id);
    check(m);
    store.course(m.courseId);
    check(
      Array.isArray(a.pages) &&
        a.pages.length < 3000 &&
        a.pages.every((p) => typeof p === "string" && p.length < 100000),
    );
    store.tx(() => (m.pages = a.pages));
  },
  "audio.read": (a) => {
    if (a.utteranceId) {
      const u = store.s.utterances.find((u) => u.id === a.utteranceId);
      check(u, "转录不存在");
      store.lesson(u.lessonId);
      check(
        u.startMs != null && u.endMs != null && u.endMs - u.startMs <= 120000,
        "转录没有可回听的时间范围",
      );
      const chunks = store.s.chunks
        .filter(
          (c) =>
            c.lessonId === u.lessonId &&
            c.endMs > u.startMs &&
            c.startMs < u.endMs,
        )
        .sort((a, b) => a.startMs - b.startMs);
      check(chunks.length, "该转录没有可回听的本地音频");
      let header, rate;
      const parts = [];
      for (const c of chunks) {
        const b = fs.readFileSync(c.path);
        check(
          b.length >= 44 &&
            b.toString("ascii", 0, 4) === "RIFF" &&
            b.toString("ascii", 36, 40) === "data" &&
            b.readUInt16LE(22) === 1 &&
            b.readUInt16LE(34) === 16,
          "音频格式不支持合并回听",
        );
        const sr = b.readUInt32LE(24);
        check(!rate || rate === sr, "音频采样率不同");
        rate = sr;
        header = b.subarray(0, 44);
        const start = Math.max(
            0,
            Math.round(((u.startMs - c.startMs) * rate) / 1000),
          ),
          end = Math.min(
            (b.length - 44) / 2,
            Math.round(((u.endMs - c.startMs) * rate) / 1000),
          );
        if (end > start) parts.push(b.subarray(44 + start * 2, 44 + end * 2));
      }
      const data = Buffer.concat(parts),
        wav = Buffer.alloc(44 + data.length);
      header.copy(wav);
      wav.writeUInt32LE(36 + data.length, 4);
      wav.writeUInt32LE(data.length, 40);
      data.copy(wav, 44);
      const missing = require("./study.cjs").gaps(
        u.endMs - u.startMs,
        chunks.map((c) => ({
          startMs: Math.max(0, c.startMs - u.startMs),
          endMs: c.endMs - u.startMs,
        })),
      );
      check(!missing.length, "回听范围内音频缺失，请先恢复录音文件");
      return wav;
    }
    const c = store.s.chunks.find((c) => c.id === a.id);
    check(c);
    store.lesson(c.lessonId);
    return fs.readFileSync(c.path);
  },
  "audio.import": async (a) => {
    const l = store.lesson(a.lessonId);
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "音频", extensions: ["wav", "mp3"] }],
    });
    if (r.canceled) return null;
    const data = fs.readFileSync(r.filePaths[0]);
    check(data.length < 150 * 1024 * 1024, "音频不能超过 150 MB");
    return { data, name: path.basename(r.filePaths[0]), lessonId: l.id };
  },
  "audio.backfill": (a) => {
    if (store.s.config.asrBackend === "local" && localRuns.has(a.lessonId))
      return localBackfill(a.lessonId);
    check(
      !configuring && !tingwuTestRun && !backfillTasks.has(a.lessonId),
      "正在处理 API 请求或补转写，请稍候",
    );
    const task =
      store.s.config.asrBackend === "local"
        ? localBackfill(a.lessonId)
        : backfill(a.lessonId);
    backfillTasks.set(a.lessonId, task);
    return task
      .then((result) => {
        const l = store.lesson(a.lessonId);
        if (l.recording === "stopped")
          store.tx(() => {
            l.asrFinalized = true;
            l.writeComplete = !require("./study.cjs").gaps(
              l.captureMs,
              store.s.chunks.filter((c) => c.lessonId === l.id),
            ).length;
            if (l.writeComplete) l.captureError = null;
          });
        return result;
      })
      .finally(() => backfillTasks.delete(a.lessonId));
  },
  "template.save": (a) => {
    const c = store.course(a.courseId);
    check(c.template.version === a.version, "模板已变化，请重新打开");
    validateTemplate(a.rules);
    store.tx(() => {
      c.template = {
        id: c.template.id,
        version: c.template.version + 1,
        rules: clone(a.rules),
      };
    });
  },
  "template.clone": (a) => {
    const source = store.course(a.from),
      target = store.course(a.to);
    check(source.id !== target.id);
    store.tx(
      () =>
        (target.template = {
          id: id(),
          version: 1,
          rules: clone(source.template.rules),
        }),
    );
  },
  "template.draft": (a) => {
    const l = a.lessonId ? store.lesson(a.lessonId) : null,
      c = store.course(a.courseId || l.courseId);
    const input = {
      kind: "template",
      preference: text(a.preference, 4000),
      sample: text(a.sample || "", 12000),
      rules: c.template.rules,
      provider: clone(store.s.config),
    };
    return store.tx((s) => {
      const t = {
        id: id(),
        lessonId: l?.id,
        courseId: c.id,
        type: "template",
        key: hash(input),
        input,
        state: "queued",
        lane: "background",
        createdAt: Date.now(),
        attempt: 0,
        preview: "",
        error: null,
      };
      s.tasks.push(t);
      return t;
    });
  },
  "template.preview": (a) => {
    validateTemplate(a.rules);
    return store.enqueue(a.lessonId, {
      preview: true,
      template: { id: "preview", version: 0, rules: a.rules },
      topicIds: a.topicIds,
      context:
        a.topicIds?.length === 1
          ? { ...store.lesson(a.lessonId).context, topicId: a.topicIds[0] }
          : undefined,
    });
  },
  "provider.configure": async (a) => {
    check(
      !record && !recordingBusy && !tingwuTestRun && !configuring,
      "请先停止录音或等待 API 操作完成，再保存配置",
    );
    configuring = true;
    try {
      check(["off", "mock", "http"].includes(a.mode));
      const asrProvider = a.asrProvider || "openai";
      check(["openai", "tingwu"].includes(asrProvider), "请选择语音提供商");
      const tingwuAppKey = text(a.tingwuAppKey || "", 200).trim();
      const tingwuLanguage = a.tingwuLanguage || "cn";
      check(
        ["cn", "en", "fspk", "ja", "yue"].includes(tingwuLanguage),
        "不支持的听悟语种",
      );
      if (asrProvider === "tingwu" && a.mode === "http") {
        check(tingwuAppKey, "请填写听悟项目 AppKey");
        check(
          a.tingwuId?.trim() || store.s.secrets.tingwuId,
          "请填写听悟 AccessKey ID",
        );
        check(
          a.tingwuSecret?.trim() || store.s.secrets.tingwuSecret,
          "请填写听悟 AccessKey Secret",
        );
      }
      if (a.mode === "http") {
        endpoint(a.textUrl);
        if (asrProvider === "openai") {
          endpoint(a.asrUrl, "wss:");
          endpoint(a.fileUrl);
        }
      }
      check(
        Number.isInteger(a.maxCalls) && a.maxCalls > 0 && a.maxCalls <= 10000,
      );
      check(
        Number.isInteger(a.maxOutput) &&
          a.maxOutput >= MIN_OUTPUT_TOKENS &&
          a.maxOutput <= MAX_OUTPUT_TOKENS,
        `单次最大输出 tokens 必须为 ${MIN_OUTPUT_TOKENS}–${MAX_OUTPUT_TOKENS} 的整数`,
      );
      check(
        a.textThinking == null || typeof a.textThinking === "boolean",
        "思考模式必须为开启或关闭",
      );
      for (const k of ["textModel", "asrModel", "fileModel", "policy"])
        text(a[k], 2000);
      for (const k of ["textKey", "asrKey", "tingwuId", "tingwuSecret"])
        if (a[k]) {
          text(a[k], 2000);
          check(safeStorage.isEncryptionAvailable(), "系统密钥加密不可用");
        }
      for (const t of store.s.tasks.filter((t) =>
        ["queued", "running"].includes(t.state),
      ))
        scheduler.cancel(t.id);
      await cancelBackfills();
      if (
        a.tingwuId ||
        a.tingwuSecret ||
        tingwuAppKey !== store.s.config.tingwuAppKey
      ) {
        check(
          !store.s.streams.some(
            (s) =>
              s.provider === "tingwu" &&
              s.cloudTaskId &&
              !["stopped", "failed"].includes(s.cloudState),
          ),
          "请先重试结束遗留听悟任务，再更换凭据或项目",
        );
      }
      store.tx((s) => {
        s.config = {
          mode: a.mode,
          asrBackend: s.config.asrBackend || "cloud",
          localAsrModel: s.config.localAsrModel || "sensevoice",
          textUrl: a.textUrl,
          textModel: a.textModel,
          textThinking: a.textThinking === true,
          asrUrl: a.asrUrl,
          asrModel: a.asrModel,
          asrProvider,
          tingwuAppKey,
          tingwuLanguage,
          fileUrl: a.fileUrl,
          fileModel: a.fileModel,
          maxCalls: a.maxCalls,
          maxOutput: a.maxOutput,
          policy: a.policy,
          pricing: s.config.pricing,
          version: s.config.version + 1,
        };
        if (a.textKey)
          s.secrets.text = safeStorage
            .encryptString(a.textKey)
            .toString("base64");
        if (a.asrKey)
          s.secrets.asr = safeStorage
            .encryptString(a.asrKey)
            .toString("base64");
        for (const k of ["tingwuId", "tingwuSecret"])
          if (a[k]?.trim())
            s.secrets[k] = safeStorage
              .encryptString(a[k].trim())
              .toString("base64");
      });
      if (record) record.asr = createASR(record.lid);
    } finally {
      configuring = false;
    }
  },
  "provider.tingwuCleanup": () => finishPendingTingwu(),
  "provider.tingwuTest": async (a) => {
    check(
      !record && !backfills.size && !tingwuTestRun && !configuring,
      "请先停止录音和补转写，或等待当前测试结束",
    );
    tingwuTestRun = (async () => {
      const l = ensureConsent(a.lessonId, "audio");
      check(store.s.config.asrProvider === "tingwu", "请先保存听悟配置");
      reserve(l);
      const api = new TingwuAPI(tingwuCredentials());
      const cfg = clone(store.s.config);
      const data = await api.create(cfg, `test-${id()}`);
      check(data?.taskId, "听悟未返回任务标识");
      const stream = {
        id: id(),
        lessonId: l.id,
        provider: "tingwu",
        confirmed: [],
        originMs: l.captureMs,
        cloudTaskId: data.taskId,
        cloudState: "stop-pending",
        test: true,
        tingwuAppKey: cfg.tingwuAppKey,
        createdAt: Date.now(),
      };
      try {
        store.tx((s) => s.streams.push(stream));
      } finally {
        await api.stop(data.taskId);
        store.tx(() => {
          stream.cloudState = "stopped";
        });
      }
      return { ok: true };
    })();
    try {
      return await tingwuTestRun;
    } finally {
      tingwuTestRun = null;
    }
  },
  "provider.test": async (a) => {
    const course = store.course(
      a.courseId || store.lesson(a.lessonId).courseId,
    );
    check(
      course.consent.text && course.consent.version === store.s.config.version,
      "请先授权本课程发送文本",
    );
    const task = routes["template.draft"]({
      courseId: course.id,
      preference: "只返回默认呈现规则",
    });
    await scheduler.run(task);
    check(task.state === "succeeded", task.error || "测试失败");
    return task.result;
  },
  "recording.start": (a) => recordingAction(() => startRecording(a.lessonId)),
  "recording.pause": () =>
    recordingAction(async () => {
      check(record);
      await command("pause");
      await flushAudio();
      if (record.asr.pause) await record.asr.pause();
      else record.asr.commit();
      store.tx(() => (store.lesson(record.lid).recording = "paused"));
      if (
        store.s.config.asrBackend === "local" &&
        !store.lesson(record.lid).aiPaused
      )
        void localBackfill(record.lid).catch((e) =>
          emit({ type: "warning", message: e.message }),
        );
    }),
  "recording.resume": () =>
    recordingAction(async () => {
      check(record);
      await command("resume");
      store.tx(() => (store.lesson(record.lid).recording = "recording"));
    }),
  "recording.stop": () => recordingAction(() => stopRecording()),
  ...require("./study-routes.cjs").routes(() => ({
    store,
    win,
    scheduler,
    record,
    recordingBusy,
    backfills,
    dialog,
    root,
    shell,
    importMaterial,
    exportNotes,
  })),
  "layout.save": (a) => {
    const c = store.course(a.courseId);
    check(
      a.layout.left >= 30 &&
        a.layout.left <= 70 &&
        a.layout.top >= 25 &&
        a.layout.top <= 75,
    );
    store.tx(() => (c.layout = a.layout));
  },
  "course.delete": async (a) => {
    check(
      !tingwuTestRun && !configuring && !recordingBusy,
      "请等待录音或 API 操作结束，再删除课程",
    );
    const c = store.course(a.id);
    check(a.confirm === c.name, "请输入完整课程名称确认删除");
    if (record && store.lesson(record.lid).courseId === c.id)
      await stopRecording();
    const lids = store.s.lessons
      .filter((l) => l.courseId === c.id)
      .map((l) => l.id);
    await cancelBackfills(lids);
    check(
      !store.s.streams.some(
        (s) =>
          lids.includes(s.lessonId) &&
          s.provider === "tingwu" &&
          s.cloudTaskId &&
          !["stopped", "failed"].includes(s.cloudState),
      ),
      "请先在 API 设置中结束遗留听悟任务，再删除课程",
    );
    for (const t of store.s.tasks.filter(
      (t) =>
        (lids.includes(t.lessonId) || t.courseId === c.id) &&
        ["running", "queued"].includes(t.state),
    ))
      scheduler.cancel(t.id);
    store.tx((s) => {
      c.deleted = true;
      c.deletedAt = Date.now();
    });
    cleanupCourse(c.id);
  },
  "demo.seed": () => {
    const c = store.createCourse("软件工程 · 示例课程"),
      l = store.createLesson(c.id, "01 软件生命周期");
    store.topic(l.id, "软件生命周期");
    for (const line of [
      "软件工程用系统化、规范化的方法开发和维护软件。需求分析的输出是清晰、可验证的需求规格。",
      "教师强调：瀑布模型适合需求相对稳定的项目；当需求频繁变化时，应考虑迭代式开发。",
      "以听课笔记助手为例：录音属于关键采集链路，模型失败不应中断录音。考试要求：能解释高内聚、低耦合。",
    ])
      store.addUtterance(l.id, line);
    return { courseId: c.id, lessonId: l.id };
  },
};
function validateTemplate(r) {
  check(
    r &&
      ["层级编号", "不编号", "中文序号"].includes(r.heading_numbering) &&
      ["标准", "简洁", "详细"].includes(r.detail_level) &&
      ["来源列表", "行内引用"].includes(r.source_format),
    "模板规则无效",
  );
  text(r.custom_prompt, 6000);
  check(["只给链接", "保留原图", "按需插入"].includes(r.image_policy));
}
function cleanupCourse(cid) {
  const base = path.resolve(root);
  const lids = store.s.lessons
    .filter((l) => l.courseId === cid)
    .map((l) => l.id);
  const targets = [
    path.resolve(root, "courses", cid),
    ...lids.map((l) => path.resolve(root, "lessons", l)),
  ];
  for (const t of targets) {
    check(t.startsWith(base + path.sep), "删除路径越界");
    fs.rmSync(t, { recursive: true, force: true });
  }
  store.tx((s) => {
    const tids = s.topics
      .filter((t) => lids.includes(t.lessonId) || t.courseId === cid)
      .map((t) => t.id);
    for (const k of [
      "utterances",
      "topics",
      "tasks",
      "chunks",
      "streams",
      "events",
    ])
      s[k] = s[k].filter((x) => !lids.includes(x.lessonId));
    s.candidates = s.candidates.filter((x) => !tids.includes(x.topicId));
    s.revisions = s.revisions.filter((x) => !tids.includes(x.topicId));
    for (const k of [
      "notebooks",
      "conversations",
      "artifacts",
      "attachments",
      "topics",
      "tasks",
    ])
      s[k] = s[k].filter((x) => x.courseId !== cid);
    s.materials = s.materials.filter((m) => m.courseId !== cid);
    s.lessons = s.lessons.filter((l) => l.courseId !== cid);
    const tombstone = s.courses.find((c) => c.id === cid);
    if (tombstone) {
      const deletedAt = tombstone.deletedAt;
      for (const field of Object.keys(tombstone)) delete tombstone[field];
      Object.assign(tombstone, { id: cid, deleted: true, deletedAt });
    }
  });
}
ipcMain.on("capture:ack", (event, rid, error) => {
  if (event.sender !== record?.window.webContents) return;
  const ack = captureAcks.get(rid);
  if (ack) {
    clearTimeout(ack.timeout);
    captureAcks.delete(rid);
    error ? ack.reject(new Error(error)) : ack.resolve();
  }
});
ipcMain.on("capture:frame", (event, pcm) => {
  if (!record || event.sender !== record.window.webContents) return;
  const bytes = Buffer.from(pcm);
  if (bytes.length > 10000 || bytes.length % 2) return;
  const start = record.ms;
  record.samples += bytes.length / 2;
  record.ms = record.originMs + Math.round(record.samples / 24);
  record.worker.postMessage({ type: "frame", pcm: bytes });
  record.asr.frame(bytes, start, record.ms);
  emit({ type: "clock", lessonId: record.lid, ms: record.ms });
});
ipcMain.on("capture:error", (event, message) => {
  if (event.sender !== record?.window.webContents) return;
  store.tx(
    () => (store.lesson(record.lid).captureError = "录音设备错误：" + message),
  );
  emit({ type: "warning", message: "录音设备错误：" + message });
  void stopRecording().catch(() => {});
});
ipcMain.handle("app:invoke", async (event, method, args) => {
  try {
    check(
      win &&
        !win.isDestroyed() &&
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame,
      "未授权窗口",
    );
    check(Object.hasOwn(routes, method), "未知接口");
    check(args && typeof args === "object");
    return { request_id: id(), data: await routes[method](args) };
  } catch (e) {
    return {
      request_id: id(),
      error: {
        code: e.code || "APP_ERROR",
        message: e.message,
        retryable: false,
      },
    };
  }
});
let openingWindow = null;
function showMainWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return Promise.resolve(win);
  }
  if (!openingWindow) {
    openingWindow = createMainWindow().finally(() => {
      openingWindow = null;
    });
  }
  return openingWindow;
}
async function createMainWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 970,
    minWidth: 1050,
    minHeight: 720,
    title: "听课笔记助手",
    backgroundColor: "#f6f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, "../dist/index.html"));
  win.on("close", (e) => {
    if (recordingBusy && !record) recordingStartVersion++;
    if (record && !quitting) {
      e.preventDefault();
      dialog
        .showMessageBox(win, {
          type: "question",
          message: "正在录音",
          detail: "结束并保存录音后关闭，或继续录音。",
          buttons: ["继续录音", "结束并退出"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(async (r) => {
          if (r.response === 1) {
            try {
              await stopRecording();
              quitting = true;
              app.quit();
            } catch (err) {
              emit({ type: "warning", message: err.message });
            }
          }
        });
    }
  });
  const current = win;
  current.on("closed", () => {
    if (win === current) win = null;
  });
  return current;
}
app
  .whenReady()
  .then(async () => {
    store = await Store.open(root);
    localAsr = new LocalASR({
      modelRoot:
        process.env.LECTURE_MODEL_DIR ||
        path.join(app.getPath("userData"), "models"),
      modelId: store.s.config.localAsrModel || "sensevoice",
      onChange: broadcast,
    });
    store.recover();
    recoverAudio();
    for (const c of store.s.courses.filter((c) => c.deleted))
      cleanupCourse(c.id);
    store.onChange = broadcast;
    scheduler = new Scheduler(store, key);
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, callback) =>
        callback(permission === "media" && wc === record?.window.webContents),
    );
    session.defaultSession.setPermissionCheckHandler(
      (wc, permission) =>
        permission === "media" && wc === record?.window.webContents,
    );
    await showMainWindow();
    setInterval(() => {
      for (const l of store.s.lessons.filter(
        (l) => !store.s.courses.find((c) => c.id === l.courseId)?.deleted,
      ))
        autoSubmit(l.id, l.recording === "stopped");
    }, 1500).unref();
  })
  .catch((e) => {
    dialog.showErrorBox("启动失败", e.message);
    app.quit();
  });
function activateWindow() {
  if (store && !shutdownPending && !quitting) {
    void showMainWindow().catch((error) => {
      dialog.showErrorBox("打开窗口失败", error.message);
    });
  }
}
app.on("second-instance", activateWindow);
app.on("activate", activateWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  recordingStartVersion++;
  if (!shutdownReady && (record || backfillTasks.size || tingwuTestRun)) {
    event.preventDefault();
    if (shutdownPending) return;
    shutdownPending = true;
    // Finish cloud task cleanup before allowing the last process to exit.
    void (async () => {
      try {
        await stopRecording();
        await cancelBackfills();
        await tingwuTestRun;
      } catch {
        /* Pending cloud IDs remain in the database for an explicit retry. */
      } finally {
        shutdownReady = true;
        quitting = true;
        app.quit();
      }
    })();
    return;
  }
  scheduler?.close();
  localAsr?.close();
  for (const b of backfills.values()) b.abort();
});
