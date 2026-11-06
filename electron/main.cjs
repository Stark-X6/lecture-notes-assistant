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
const { ensureMicrophonePermission } = require("./platform.cjs");
const { LiveASR } = require("./asr.cjs");
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
  await Promise.allSettled(lids.map((lid) => backfillTasks.get(lid)));
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
  worker.on("message", (m) => {
    if (m.type === "chunk") {
      try {
        store.tx((s) => {
          s.chunks.push({ id: id(), lessonId: lid, ...m });
          l.captureMs = m.endMs;
        });
        autoSubmit(lid);
      } catch (e) {
        emit({ type: "warning", message: e.message });
        stopRecording().catch(() => {});
      }
    }
    if (m.type === "error") {
      emit({ type: "warning", message: m.message });
      stopRecording().catch(() => {});
    }
  });
  worker.on("error", () => {
    emit({ type: "warning", message: "录音保存进程异常，已停止采集" });
    stopRecording().catch(() => {});
  });
  await recorder.loadFile(path.join(__dirname, "recorder.html"));
  try {
    await command("start");
    store.tx(() => {
      l.recording = "recording";
      l.recovered = false;
    });
  } catch (e) {
    await record.asr.disconnect();
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
  await command("stop");
  await flushAudio();
  await current.asr.stop();
  current.worker.postMessage({ type: "stop" });
  current.window.destroy();
  record = null;
  store.tx(() => {
    l.recording = "stopped";
    l.captureMs = current.ms;
  });
  if (l.mode === "auto") setTimeout(() => autoSubmit(l.id, true), 5500);
}
function autoSubmit(lid, tail = false) {
  const l = store.lesson(lid);
  if (l.aiPaused || store.s.config.mode === "off") return;
  const end = l.captureMs;
  const last = Math.max(0, ...l.windows.map((w) => w.end));
  if (l.mode === "auto" && (end - last >= 60000 || (tail && end > last)))
    store.tx(() =>
      l.windows.push({
        start: last,
        end: tail ? end : last + 60000,
        state: "waiting",
        context: clone(l.context),
        template: clone(store.course(l.courseId).template),
        submittedAt: Date.now(),
      }),
    );
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
    try {
      if (us.length)
        store.enqueue(lid, {
          uids: us.map((u) => u.id),
          context: w.context,
          template: w.template,
          prompt: w.prompt || "",
          submittedAt: w.submittedAt,
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
  const l = store.lesson(a.lessonId);
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
  const body = [".txt", ".srt", ".md"].includes(ext)
    ? data.toString("utf8").replace(/^\uFEFF/, "")
    : "";
  if (ext === ".srt") {
    const entries = parseSrt(body);
    for (const e of entries) store.addUtterance(l.id, e.text, e);
  }
  if (ext === ".txt")
    for (const paragraph of body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()))
      store.addUtterance(l.id, paragraph);
  if (ext === ".md") {
    check(
      !/!\[[^\]]*\]\((?!https?:|data:)[^)]+\)/.test(body),
      "Markdown 包含本地图片；请先将附件整理为外部有效链接或移除图片后导入（首版不自动复制附件）",
    );
    const t = store.topic(l.id, path.basename(file, ext));
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
    pages: [],
    createdAt: Date.now(),
  };
  store.tx((s) => s.materials.push(m));
  return { ...m, path: undefined };
}
async function exportNotes(lid) {
  const l = store.lesson(lid),
    c = store.course(l.courseId);
  const topics = clone(store.s.topics.filter((t) => t.lessonId === lid));
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
  fs.mkdirSync(path.join(temp, "sources"), { recursive: true });
  let body = `# ${c.name} · ${l.name}\n\n`;
  const all = [];
  for (const t of topics) {
    check(
      !/!\[[^\]]*\]\((?!https?:)[^)]+\)/.test(t.body),
      "笔记含未打包的本地图片，请补齐或移除后导出",
    );
    body += `## ${t.title}\n\n${t.body}\n\n`;
    if (t.sources.length) {
      body += "来源：\n";
      for (const [i, r] of t.sources.entries()) {
        const label =
          r.kind === "material"
            ? `${r.name}，第 ${r.page} 页`
            : r.startMs === null
              ? `转录第 ${r.paragraph} 段`
              : `转录 ${Math.round(r.startMs / 1000)}–${Math.round(r.endMs / 1000)} 秒`;
        const file = `${t.id}-${i}.txt`;
        fs.writeFileSync(
          path.join(temp, "sources", file),
          r.text || "",
          "utf8",
        );
        body += `- [${label}](sources/${file})\n`;
        all.push(r);
      }
      body += "\n";
    }
  }
  fs.writeFileSync(path.join(temp, "notes.md"), body, "utf8");
  fs.writeFileSync(
    path.join(temp, "manifest.json"),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        course: c.name,
        lesson: l.name,
        versions: topics.map((t) => ({ topicId: t.id, version: t.version })),
        sources: all.length,
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
    for (let pos = 0; pos < pcm.length; pos += 240000) {
      const part = pcm.subarray(pos, pos + 240000),
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
      start = end;
      await new Promise((r) => setImmediate(r));
    }
    return { durationMs: l.captureMs };
  },
  snapshot: () => store.snapshot(),
  "course.create": (a) => store.createCourse(a.name),
  "lesson.create": (a) => store.createLesson(a.courseId, a.name),
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
    const l = store.lesson(a.lessonId),
      c = store.course(l.courseId);
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
          store.s.lessons.find((l) => l.id === t.lessonId)?.courseId === c.id &&
          ["queued", "running"].includes(t.state),
      ))
        scheduler.cancel(t.id);
    if (!a.audio) {
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
    check(
      !configuring && !tingwuTestRun && !backfillTasks.has(a.lessonId),
      "正在处理 API 请求或补转写，请稍候",
    );
    const task = backfill(a.lessonId);
    backfillTasks.set(a.lessonId, task);
    return task.finally(() => backfillTasks.delete(a.lessonId));
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
    const l = store.lesson(a.lessonId),
      c = store.course(l.courseId);
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
        lessonId: l.id,
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
          a.maxOutput >= 256 &&
          a.maxOutput <= 16000,
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
          textUrl: a.textUrl,
          textModel: a.textModel,
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
    const l = ensureConsent(a.lessonId, "text");
    reserve(l);
    return generate(
      store.s.config,
      key("text"),
      {
        kind: "template",
        preference: "只返回默认呈现规则",
        rules: DEFAULT_TEMPLATE,
      },
      AbortSignal.timeout(15000),
    );
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
    }),
  "recording.resume": () =>
    recordingAction(async () => {
      check(record);
      await command("resume");
      store.tx(() => (store.lesson(record.lid).recording = "recording"));
    }),
  "recording.stop": () => recordingAction(() => stopRecording()),
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
        lids.includes(t.lessonId) && ["running", "queued"].includes(t.state),
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
      .filter((t) => lids.includes(t.lessonId))
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
  emit({ type: "warning", message: "录音设备错误：" + message });
});
ipcMain.handle("app:invoke", async (event, method, args) => {
  try {
    check(
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
  for (const b of backfills.values()) b.abort();
});
