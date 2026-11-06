import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Mic,
  Pause,
  Play,
  Square,
  Plus,
  Settings,
  Upload,
  Download,
  FileText,
  ChevronLeft,
  ChevronRight,
  Check,
  ArrowUpRight,
  LayoutGrid,
  History,
  Layers,
  Sparkles,
  X,
  RefreshCw,
  Radio,
  ShieldCheck,
  Folder,
  MoreHorizontal,
  Send,
  Search,
  Headphones,
  Trash2,
  GitCompare,
  Volume2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./style.css";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
declare global {
  interface Window {
    desktop: {
      invoke: (method: string, args?: any) => Promise<any>;
      subscribe: (cb: (e: any) => void) => () => void;
    };
  }
}
const api = window.desktop;
const clock = (ms: number | null) =>
  ms === null
    ? "无时间戳"
    : `${Math.floor(ms / 60000)
        .toString()
        .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
        .toString()
        .padStart(2, "0")}`;
const invoke = (m: string, a: any = {}) => api.invoke(m, a);
type Obj = Record<string, any>;
const statusNames: Obj = {
  queued: "等待整理",
  running: "整理中",
  failed: "处理失败",
  succeeded: "已完成",
  cancelled: "已取消",
};
const localAsrStateNames: Obj = {
  missing: "未安装模型",
  downloading: "正在下载模型",
  ready: "已就绪",
  loading: "正在加载模型",
  recognizing: "正在识别",
  error: "识别出错",
};
const fallbackLocalAsr: Obj = {
  ready: false,
  state: "missing",
  progress: 0,
  error: null,
  modelId: "sensevoice",
  modelName: "SenseVoiceSmall INT8",
  modelDir: "",
  queued: 0,
  models: [
    {
      id: "sensevoice",
      name: "SenseVoiceSmall INT8",
      downloadMB: 240,
      ready: false,
      modelPage: "",
    },
    {
      id: "qwen3",
      name: "Qwen3-ASR-0.6B INT8",
      downloadMB: 987,
      ready: false,
      modelPage: "",
    },
  ],
};
function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => <span className="safe-link">{children}</span>,
          img: ({ alt }) => <span>[图片：{alt || "附件"}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
function App() {
  const [s, setS] = useState<Obj | null>(null),
    [cid, setCid] = useState(""),
    [lid, setLid] = useState(""),
    [tid, setTid] = useState(""),
    [modal, setModal] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [partial, setPartial] = useState(""),
    [elapsed, setElapsed] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [hint, setHint] = useState(""),
    [search, setSearch] = useState(""),
    [focusSource, setFocusSource] = useState(""),
    [layout, setLayout] = useState({ left: 50, top: 54 });
  const flush = useRef<() => Promise<void>>(async () => {}),
    refreshing = useRef(false),
    refreshAgain = useRef(false),
    lessonRef = useRef(lid);
  lessonRef.current = lid;
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    try {
      setS(await invoke("snapshot"));
    } finally {
      refreshing.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    return api.subscribe((e) => {
      if (e.type === "changed") void refresh();
      if (e.type === "warning") setNotice(e.message);
      if (e.lessonId === lessonRef.current) {
        if (e.type === "partial") setPartial(e.text);
        if (e.type === "clock") setElapsed(e.ms);
      }
    });
  }, [refresh]);
  const course = s?.courses.find((c: Obj) => c.id === cid && !c.deleted),
    lessons = s?.lessons.filter((l: Obj) => l.courseId === cid) || [],
    lesson = lessons.find((l: Obj) => l.id === lid),
    topics = s?.topics.filter((t: Obj) => t.lessonId === lid) || [],
    topic = topics.find((t: Obj) => t.id === tid),
    utterances =
      s?.utterances
        .filter((u: Obj) => u.lessonId === lid)
        .sort(
          (a: Obj, b: Obj) =>
            (a.startMs ?? Infinity) - (b.startMs ?? Infinity) ||
            a.createdAt - b.createdAt,
        ) || [],
    tasks = s?.tasks.filter((t: Obj) => t.lessonId === lid) || [],
    materials = s?.materials.filter((m: Obj) => m.courseId === cid) || [],
    candidates =
      s?.candidates.filter(
        (c: Obj) =>
          topics.some((t: Obj) => t.id === c.topicId) && c.status === "pending",
      ) || [];
  useEffect(() => {
    if (!s) return;
    if (!course) {
      const c = s.courses.find((c: Obj) => !c.deleted);
      setCid(c?.id || "");
    }
  }, [s, cid]);
  useEffect(() => {
    if (course) setLayout(course.layout || { left: 50, top: 54 });
  }, [cid]);
  useEffect(() => {
    if (!lesson) {
      setLid(lessons[0]?.id || "");
      setTid("");
    }
  }, [s, cid, lid]);
  useEffect(() => {
    if (!topic) setTid(topics[0]?.id || "");
  }, [s, lid, tid]);
  useEffect(() => {
    setElapsed(lesson?.captureMs || 0);
    setPartial("");
    setSelected([]);
  }, [lid]);
  const run = async (fn: () => Promise<any>, save = true) => {
    setBusy(true);
    try {
      if (save) await flush.current();
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setNotice((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const call = (method: string, args: Obj = {}) =>
    run(
      () => invoke(method, { lessonId: lid, ...args }),
      !method.startsWith("recording.") && method !== "ai.pause",
    );
  const changeCourse = async (id: string) => {
    await run(async () => {
      setCid(id);
      setLid("");
      setTid("");
    });
  };
  const recording = lesson?.recording === "recording",
    paused = lesson?.recording === "paused";
  const stateOf = (u: Obj) => {
    const t = tasks.find(
      (t: Obj) =>
        t.type === "notes" &&
        t.state === "succeeded" &&
        s?.events.some(
          (e: Obj) =>
            e.type === "submission.created" &&
            e.payload.taskId === t.id &&
            e.payload.sourceIds.includes(`u:${u.id}:${u.revision}`),
        ),
    );
    return t ? "已整理" : "待提交";
  };
  const importPdf = async (kind: string) => {
    const m = await invoke("material.import", { lessonId: lid, kind });
    if (m?.ext === ".pdf") {
      const bytes = await invoke("material.read", { id: m.id });
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) })
        .promise;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const text = await page.getTextContent();
        pages.push(text.items.map((x: any) => x.str || "").join(" "));
      }
      await invoke("material.index", { id: m.id, pages });
      await invoke("lesson.context", {
        lessonId: lid,
        context: { ...lesson.context, [kind]: { id: m.id, from: 1, to: 1 } },
      });
      await doc.destroy();
      if (!pages.some((p) => p.trim()))
        setNotice("此 PDF 无可提取文字，仍可预览；扫描 OCR 不在首版范围内。");
    }
  };
  const openSource = async (ref: Obj) => {
    if (ref.kind === "material") {
      const m = materials.find((m: Obj) => m.id === ref.targetId);
      if (m)
        await call("lesson.context", {
          context: {
            ...lesson.context,
            [m.kind]: { id: m.id, from: ref.page, to: ref.page },
          },
        });
    } else {
      setFocusSource(ref.targetId);
      document
        .getElementById(ref.targetId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  const playAudio = async (u: Obj) => {
    const data = await invoke("audio.read", { utteranceId: u.id });
    if (!data) {
      setNotice("该转录没有可回听的本地音频");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(data)], { type: "audio/wav" }),
    );
    const audio = new Audio(url);
    audio.currentTime = 0;
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  };
  const resize = (axis: string, e: React.PointerEvent) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement!;
    const rect = container.getBoundingClientRect();
    const initial = { ...layout };
    const move = (ev: PointerEvent) =>
      setLayout({
        ...initial,
        [axis]: Math.min(
          axis === "left" ? 70 : 75,
          Math.max(
            axis === "left" ? 30 : 25,
            (axis === "left"
              ? (ev.clientX - rect.left) / rect.width
              : (ev.clientY - rect.top) / rect.height) * 100,
          ),
        ),
      });
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  useEffect(() => {
    if (!course) return;
    const timer = setTimeout(
      () => invoke("layout.save", { courseId: cid, layout }).catch(() => {}),
      600,
    );
    return () => clearTimeout(timer);
  }, [layout, cid]);
  if (!s)
    return (
      <div className="loading">
        <BookOpen size={40} />
        <p>正在打开本地笔记库…</p>
      </div>
    );
  const asrBackend = s.config?.asrBackend === "local" ? "local" : "cloud";
  const localAsr = { ...fallbackLocalAsr, ...(s.localAsr || {}) };
  const localAsrState = String(localAsr.state || (localAsr.ready ? "ready" : "missing"));
  const localAsrReady = Boolean(localAsr.ready || localAsrState === "ready");
  const localAsrLabel =
    localAsrStateNames[localAsrState] || (localAsrReady ? "已就绪" : "状态未知");
  const cloudAsrReady =
    s.config?.mode === "http" &&
    (s.config?.asrProvider === "tingwu"
      ? Boolean(
          s.config?.tingwuAppKey &&
            s.config?.hasTingwuId &&
            s.config?.hasTingwuSecret,
        )
      : Boolean(s.config?.asrUrl && s.config?.hasAsrKey));
  const retranscribeReady =
    asrBackend === "local"
      ? localAsrReady
      : cloudAsrReady &&
        Boolean(
          course?.consent?.audio &&
            course?.consent?.version === s.config?.version,
        );
  const localAsrBanner =
    localAsrState === "downloading"
      ? "本地语音识别：正在下载模型（" + Math.round(Number(localAsr.progress) || 0) + "%）"
      : localAsrState === "error"
        ? "本地识别出错：" + (localAsr.error || "请打开设置查看详情")
        : ["loading", "recognizing"].includes(localAsrState)
          ? "本地语音识别：" + localAsrLabel
          : localAsrReady
            ? "本地语音识别已启用：音频留在本机，约 5 秒落盘，按 12–20 秒结合低能量停顿取边界"
            : "本地语音识别：" + localAsrLabel + "，打开设置按需下载模型";
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <BookOpen size={21} />
          </div>
          <div>
            听课笔记<span>LECTURE NOTES</span>
          </div>
        </div>
        <button className="nav-item active">
          <LayoutGrid size={18} />
          学习工作台
        </button>
        <div className="section-label">
          我的课程
          <button title="新建课程" onClick={() => setModal("course")}>
            <Plus size={16} />
          </button>
        </div>
        <div className="course-list">
          {s.courses
            .filter((c: Obj) => !c.deleted)
            .map((c: Obj) => (
              <button
                key={c.id}
                className={"course-item " + (cid === c.id ? "chosen" : "")}
                onClick={() => void changeCourse(c.id)}
              >
                <span className="course-dot" />
                <span>{c.name}</span>
                {cid === c.id && <ChevronRight size={15} />}
              </button>
            ))}
        </div>
        {course && (
          <>
            <div className="section-label">
              课堂记录
              <button title="新建课次" onClick={() => setModal("lesson")}>
                <Plus size={16} />
              </button>
            </div>
            <div className="lesson-list">
              {lessons.map((l: Obj, i: number) => (
                <button
                  key={l.id}
                  className={lid === l.id ? "chosen" : ""}
                  onClick={() =>
                    void run(async () => {
                      setLid(l.id);
                      setTid("");
                    })
                  }
                >
                  <FileText size={15} />
                  <span>{l.name}</span>
                  <small>{String(i + 1).padStart(2, "0")}</small>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="local-card">
            <ShieldCheck size={18} />
            <div>
              本地优先<span>课堂资料，保存在这台电脑</span>
            </div>
          </div>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings size={18} />
            API 与设置
            <span
              className={"dot " + (s.config.mode === "http" ? "green" : "")}
            />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            我的课程
            <ChevronRight size={14} />
            <strong>{course?.name || "开始一段新的学习"}</strong>
            {lesson && (
              <>
                <ChevronRight size={14} />
                <span>{lesson.name}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            <span className="local-badge">
              <span />
              本地工作区
            </span>
            <button
              className="icon-btn"
              title="课程管理"
              onClick={() => setModal("manage")}
              disabled={!course}
            >
              <MoreHorizontal size={21} />
            </button>
            <div className="avatar">学</div>
          </div>
        </header>
        {asrBackend === "local" && (
          <div className={"connection-strip local-asr-strip " + (localAsrState === "error" ? "error" : "")}>
            <span>
              <span className={"dot " + (localAsrReady && localAsrState !== "error" ? "green" : "")} />
              {localAsrBanner}
            </span>
            <button onClick={() => setModal("settings")}>
              管理本地识别
              <ArrowUpRight size={13} />
            </button>
          </div>
        )}
        {!lesson ? (
          <div className="onboarding">
            <div className="hero-mark">
              <BookOpen size={40} />
            </div>
            <span className="eyebrow">把注意力留给课堂</span>
            <h1>听懂每一刻，留下每个重点。</h1>
            <p>
              课件、教材、课堂转录与笔记，在一个工作台自然连接。
              <br />
              先建一门课；没有 API 也能录音、编辑和导出。
            </p>
            <div className="row center">
              <button
                className="primary"
                onClick={() => setModal(course ? "lesson" : "course")}
              >
                <Plus size={17} />
                {course ? "新建课次" : "创建第一门课程"}
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void run(async () => {
                    const d = await invoke("demo.seed");
                    setCid(d.courseId);
                    setLid(d.lessonId);
                  })
                }
              >
                打开示例课程
                <ArrowUpRight size={16} />
              </button>
            </div>
            <div className="intro-cards">
              <div>
                <Layers />
                <h3>四区，保持专注</h3>
                <p>对照阅读，让来源始终可见</p>
              </div>
              <div>
                <Mic />
                <h3>录音持续保存</h3>
                <p>网络断开，课堂也不会丢失</p>
              </div>
              <div>
                <History />
                <h3>修改有迹可循</h3>
                <p>AI 建议确认后才覆盖人工笔记</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="workspace-heading">
              <div>
                <span className="eyebrow">CLASSROOM WORKSPACE</span>
                <h1>{lesson.name}</h1>
                <p>
                  {new Date(lesson.createdAt).toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                  })}
                  <span>·</span>
                  {topics.length} 个知识主题<span>·</span>
                  {materials.length} 份课程资料
                </p>
              </div>
              <div className="row">
                <button
                  className="secondary"
                  onClick={() => setModal("template")}
                >
                  <Layers size={16} />
                  课程模板{" "}
                  <span className="tiny-badge">v{course.template.version}</span>
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void call("note.export")}
                >
                  <Download size={16} />
                  导出笔记
                </button>
              </div>
            </div>
            <div className="recordbar">
              <div className="record-group">
                <span
                  className={"record-indicator " + (recording ? "live" : "")}
                />
                <div className="timer">
                  {clock(elapsed || lesson.captureMs)}
                </div>
                <span className="muted">
                  {recording ? "正在录音" : paused ? "已暂停" : "准备就绪"}
                </span>
                {!recording && !paused ? (
                  <button
                    className="record-button"
                    disabled={busy}
                    onClick={() => void call("recording.start")}
                  >
                    <Mic size={16} />
                    开始录音
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary compact"
                      disabled={busy}
                      onClick={() =>
                        void call(
                          paused ? "recording.resume" : "recording.pause",
                        )
                      }
                    >
                      {paused ? <Play size={15} /> : <Pause size={15} />}{" "}
                      {paused ? "继续" : "暂停"}
                    </button>
                    <button
                      className="icon-btn stop"
                      title="结束并保存录音"
                      disabled={busy}
                      onClick={() => void call("recording.stop")}
                    >
                      <Square size={14} />
                    </button>
                  </>
                )}
              </div>
              <div className="record-right">
                <span className="muted">整理模式</span>
                <div className="segmented">
                  <button
                    className={lesson.mode === "semi" ? "selected" : ""}
                    onClick={() => void call("lesson.mode", { mode: "semi" })}
                  >
                    半自动
                  </button>
                  <button
                    className={lesson.mode === "auto" ? "selected" : ""}
                    onClick={() => void call("lesson.mode", { mode: "auto" })}
                  >
                    自动 · 60秒
                  </button>
                </div>
                <span className="vertical-line" />
                <button
                  className="text-button"
                  onClick={() => setModal("tasks")}
                >
                  <Radio size={15} />
                  {
                    tasks.filter((t: Obj) =>
                      ["queued", "running"].includes(t.state),
                    ).length
                  }{" "}
                  个进行中
                </button>
                <button
                  className="icon-btn"
                  title={lesson.aiPaused ? "恢复 AI" : "停止 AI，继续录音"}
                  onClick={() =>
                    void call("ai.pause", { paused: !lesson.aiPaused })
                  }
                >
                  {lesson.aiPaused ? <Play size={15} /> : <Pause size={15} />}
                </button>
              </div>
            </div>
            {(s.config.mode !== "http" ||
              !course.consent.text ||
              course.consent.version !== s.config.version) && (
              <div className="connection-strip">
                <span>
                  <span className="dot" />
                  {s.config.mode === "mock"
                    ? "模拟模式：生成内容仅用于流程演示"
                    : s.config.mode === "off"
                      ? asrBackend === "local"
                        ? "文本 AI 已关闭：本地语音识别仍可用，配置文本 API 后可整理笔记"
                        : "离线模式：录音和编辑可用，配置 API 后可转写与整理"
                      : "首次使用此服务，请确认本课程的数据授权"}
                </span>
                <button onClick={() => setModal("settings")}>
                  {s.config.mode === "http"
                    ? "查看授权"
                    : asrBackend === "local"
                      ? "配置文本 API（可选）"
                      : "配置 API"}
                  <ArrowUpRight size={13} />
                </button>
              </div>
            )}
            <div
              className="workspace"
              style={{
                gridTemplateColumns: `minmax(0,${layout.left}fr) 8px minmax(0,${100 - layout.left}fr)`,
              }}
            >
              <div
                className="column"
                style={{
                  gridTemplateRows: `minmax(180px,${layout.top}fr) 8px minmax(160px,${100 - layout.top}fr)`,
                }}
              >
                <MaterialPanel
                  kind="slides"
                  title="课程课件"
                  subtitle="让讲解有迹可循"
                  materials={materials}
                  range={lesson.context.slides}
                  onImport={() => void run(() => importPdf("slides"))}
                  onRange={(r) =>
                    void call("lesson.context", {
                      context: { ...lesson.context, slides: r },
                    })
                  }
                  onError={setNotice}
                />
                <div
                  className="resize horizontal"
                  onPointerDown={(e) => resize("top", e)}
                />
                <MaterialPanel
                  kind="book"
                  title="参考教材"
                  subtitle="补足理解的另一种视角"
                  materials={materials}
                  range={lesson.context.book}
                  onImport={() => void run(() => importPdf("book"))}
                  onRange={(r) =>
                    void call("lesson.context", {
                      context: { ...lesson.context, book: r },
                    })
                  }
                  onError={setNotice}
                />
              </div>
              <div
                className="resize vertical"
                onPointerDown={(e) => resize("left", e)}
              />
              <div
                className="column"
                style={{
                  gridTemplateRows: `minmax(180px,${layout.top}fr) 8px minmax(160px,${100 - layout.top}fr)`,
                }}
              >
                <section className="panel note-panel">
                  <div className="panel-header">
                    <div className="panel-title">
                      <span className="panel-symbol purple">
                        <FileText size={17} />
                      </span>
                      <h2>知识笔记</h2>
                      <span className="muted small">持续沉淀</span>
                    </div>
                    <div className="row gap6">
                      {candidates.length > 0 && (
                        <button
                          className="candidate-badge"
                          onClick={() => setModal("candidates")}
                        >
                          {candidates.length} 个候选
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title="版本历史"
                        onClick={() => setModal("history")}
                      >
                        <History size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="topic-tabs">
                    {topics.map((t: Obj) => (
                      <button
                        className={tid === t.id ? "active" : ""}
                        key={t.id}
                        onClick={() => void run(async () => setTid(t.id))}
                      >
                        {t.title}
                        {t.human && <span title="人工编辑保护">·</span>}
                      </button>
                    ))}
                    <button title="新建主题" onClick={() => setModal("topic")}>
                      <Plus size={15} />
                    </button>
                  </div>
                  {tasks
                    .filter((t: Obj) => t.state === "running" && t.preview)
                    .map((t: Obj) => (
                      <div className="live-preview" key={t.id}>
                        <span>
                          <Sparkles size={12} />
                          AI 正在整理 · 未验证预览
                        </span>
                        <p>{t.preview.slice(-800)}</p>
                      </div>
                    ))}
                  {topic ? (
                    <NoteEditor
                      key={topic.id}
                      topic={topic}
                      flushRef={flush}
                      onError={setNotice}
                      onSaved={refresh}
                      onSource={openSource}
                    />
                  ) : (
                    <Empty
                      icon={<FileText size={30} />}
                      title="你的知识，会在这里成形"
                      description="提交一段课堂转录，或手动创建第一个主题。"
                      action="新建主题"
                      onAction={() => setModal("topic")}
                    />
                  )}
                </section>
                <div
                  className="resize horizontal"
                  onPointerDown={(e) => resize("top", e)}
                />
                <section className="panel transcript-panel">
                  <div className="panel-header">
                    <div className="panel-title">
                      <span className="panel-symbol green">
                        <Radio size={17} />
                      </span>
                      <h2>课堂转录</h2>
                      <span className="count">{utterances.length}</span>
                      {partial && <span className="listening">实时识别中</span>}
                    </div>
                    <div className="row gap6">
                      <button
                        className="text-button small"
                        onClick={() => void run(() => importPdf("transcript"))}
                      >
                        <Upload size={13} />
                        导入
                      </button>
                      <button
                        className="icon-btn"
                        title="手动输入转录"
                        onClick={() => setModal("transcript")}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                  {utterances.length > 0 && (
                    <div className="transcript-filter">
                      <Search size={14} />
                      <input
                        placeholder="搜索课堂内容…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {selected.length > 0 && (
                        <button
                          className="text-button"
                          onClick={() => setModal("assign")}
                        >
                          归入主题 ({selected.length})
                        </button>
                      )}
                    </div>
                  )}
                  <div className="transcript-scroll">
                    {utterances
                      .filter((u: Obj) => u.text.includes(search))
                      .map((u: Obj, i: number) => (
                        <div
                          id={u.id}
                          key={u.id}
                          className={
                            "utterance " +
                            (selected.includes(u.id) ? "selected " : "") +
                            (u.needsReview ? "needs-review " : "") +
                            (focusSource === u.id ? "highlight" : "")
                          }
                        >
                          <div className="utterance-meta">
                            <input
                              type="checkbox"
                              aria-label={`选择转录 ${i + 1}`}
                              checked={selected.includes(u.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, u.id]
                                    : selected.filter((x) => x !== u.id),
                                )
                              }
                            />
                            <span>
                              {u.startMs === null
                                ? `第 ${i + 1} 段`
                                : clock(u.startMs)}
                            </span>
                            <span className="source-tag">
                              {u.topicId
                                ? topics.find((t: Obj) => t.id === u.topicId)
                                    ?.title
                                : "待归类"}
                            </span>
                            <small>{stateOf(u)}</small>
                            {u.needsReview && (
                              <span
                                className="review-flag"
                                title={u.reviewReason || "识别结果需要回听核对"}
                              >
                                <AlertCircle size={12} />
                                待回听核对
                              </span>
                            )}
                            {u.startMs !== null && (
                              <button
                                className="icon-btn"
                                title="回听此处（分片定位）"
                                onClick={() =>
                                  void run(() => playAudio(u), false)
                                }
                              >
                                <Volume2 size={13} />
                              </button>
                            )}
                            <button
                              className="text-button small"
                              onClick={() => setModal("revise:" + u.id)}
                            >
                              纠错
                            </button>
                          </div>
                          {u.needsReview && (
                            <div className="review-reason">
                              <AlertCircle size={13} />
                              {u.reviewReason || "识别结果疑似复述课程术语，请回听核对"}
                            </div>
                          )}
                          <p>{u.text}</p>
                        </div>
                      ))}
                    {partial && (
                      <div className="utterance partial">
                        <div className="utterance-meta">
                          <span className="dot green" />
                          正在转写 · 未定稿
                        </div>
                        <p>
                          {partial}
                          <span className="cursor" />
                        </p>
                      </div>
                    )}
                    {!utterances.length && !partial && (
                      <Empty
                        icon={<Mic size={28} />}
                        title="每一句讲解，都值得留住"
                        description="开始录音，或导入 TXT / SRT 转录。"
                        action="输入课堂内容"
                        onAction={() => setModal("transcript")}
                      />
                    )}
                  </div>
                  <div className="submit-area">
                    <input
                      value={hint}
                      onChange={(e) => setHint(e.target.value)}
                      placeholder="给本段一个提示，例如：重点整理老师的推导过程"
                    />
                    <div className="submit-bottom">
                      <span>
                        {selected.length
                          ? `已选 ${selected.length} 段`
                          : `${utterances.filter((u: Obj) => stateOf(u) !== "已整理").length} 段待整理`}
                        {lesson.windows.some(
                          (w: Obj) => w.state === "waiting",
                        ) && " · 等待转写补齐"}
                      </span>
                      <button
                        className="primary compact"
                        disabled={busy || lesson.aiPaused || !utterances.length}
                        onClick={() =>
                          void call("submission.create", {
                            prompt: hint,
                            ...(selected.length ? { uids: selected } : {}),
                          })
                        }
                      >
                        <Sparkles size={14} />
                        提交本段
                        <ArrowUpRight size={14} />
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
            <footer className="statusbar">
              <span>
                <ShieldCheck size={12} />
                原始资料与笔记保存在本机
              </span>
              <div>
                <span className={"asr-footer-status " + (asrBackend === "local" ? "local" : "")}>
                  <Mic size={12} />
                  {asrBackend === "local"
                    ? "本地语音识别 · " +
                      (localAsrState === "error"
                        ? "出错"
                        : localAsrReady
                          ? "已启用"
                          : localAsrLabel)
                    : "云端语音识别"}
                </span>
                <span>·</span>
                <button onClick={() => void call("audio.backfill")}>
                  补转写
                </button>
                <span>·</span>
                <button
                  disabled={busy}
                  title="确认后按当前语音识别配置处理原录音，原转录和笔记保留"
                  onClick={() => setModal("retranscribe")}
                >
                  重新转写原录音
                </button>
                <span>·</span>
                <button
                  onClick={() =>
                    void call("submission.create", { all: true, prompt: hint })
                  }
                >
                  整课整理
                </button>
                <span>·</span>
                <button onClick={() => setModal("tasks")}>
                  {s.config.mode === "mock"
                    ? "模拟服务"
                    : s.config.mode === "http"
                      ? "API 已配置"
                      : "API 未配置"}{" "}
                  · 本课调用 {lesson.calls}/{s.config.maxCalls}
                </button>
              </div>
            </footer>
          </>
        )}
      </main>
      {notice && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <span>{notice}</span>
          <button onClick={() => setNotice("")} title="关闭通知">
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            {
              course: "新建课程",
              lesson: "新建课次",
              topic: "新建知识主题",
              transcript: "添加课堂转录",
              assign: "修正主题归属",
              settings: "API 与本机设置",
              retranscribe: "重新转写原录音",
              template: "课程模板",
              tasks: "处理任务",
              candidates: "候选更新",
              history: "笔记版本历史",
              manage: "课程管理",
            }[modal] || "修正转录"
          }
          onClose={() => setModal("")}
          wide={["settings", "template", "candidates", "tasks"].includes(modal)}
        >
          {["course", "lesson", "topic", "transcript"].includes(modal) && (
            <InputForm
              multiline={modal === "transcript"}
              placeholder={
                modal === "course"
                  ? "例如：软件工程"
                  : modal === "lesson"
                    ? "例如：第 1 讲 · 软件生命周期"
                    : modal === "topic"
                      ? "知识主题名称"
                      : "输入或粘贴课堂讲解内容…"
              }
              onSubmit={(value) =>
                void run(async () => {
                  const method = {
                    course: "course.create",
                    lesson: "lesson.create",
                    topic: "topic.create",
                    transcript: "transcript.add",
                  }[modal]!;
                  const r = await invoke(method, {
                    name: value,
                    title: value,
                    text: value,
                    courseId: cid,
                    lessonId: lid,
                  });
                  if (modal === "course") {
                    setCid(r.id);
                    const l = await invoke("lesson.create", {
                      courseId: r.id,
                      name: "第 1 讲",
                    });
                    setLid(l.id);
                  }
                  if (modal === "lesson") setLid(r.id);
                  if (modal === "topic") setTid(r.id);
                  setModal("");
                })
              }
            />
          )}
          {modal.startsWith("revise:") && (
            <InputForm
              multiline
              initial={
                utterances.find((u: Obj) => u.id === modal.slice(7))?.text
              }
              onSubmit={(value) =>
                void run(async () => {
                  const u = utterances.find(
                    (u: Obj) => u.id === modal.slice(7),
                  );
                  await invoke("transcript.revise", {
                    id: u.id,
                    revision: u.revision,
                    text: value,
                  });
                  setModal("");
                })
              }
            />
          )}
          {modal === "assign" && (
            <>
              <p className="modal-description">
                将选中的 {selected.length}{" "}
                段内容关联到指定主题。修改会保存归属，并在下一次整理时生效。
              </p>
              {topics.map((t: Obj) => (
                <button
                  className="selection-row"
                  key={t.id}
                  onClick={() =>
                    void run(async () => {
                      await invoke("topic.assign", {
                        lessonId: lid,
                        ids: selected,
                        topicId: t.id,
                      });
                      setSelected([]);
                      setModal("");
                    })
                  }
                >
                  <FileText size={17} />
                  {t.title}
                  <ArrowUpRight size={16} />
                </button>
              ))}
              <button className="secondary" onClick={() => setModal("topic")}>
                先创建新主题
              </button>
            </>
          )}
          {modal === "settings" && (
            <SettingsForm
              config={s.config}
              localAsr={localAsr}
              course={course}
              lessonId={lid}
              onRun={run}
              onClose={() => setModal("")}
            />
          )}
          {modal === "template" && course && (
            <TemplateForm
              course={course}
              courses={s.courses.filter((c: Obj) => !c.deleted)}
              lessonId={lid}
              tasks={tasks}
              onRun={run}
            />
          )}
          {modal === "tasks" && (
            <>
              <p className="modal-description">
                课堂任务并发 2，后台任务并发 1。课堂总时限 18
                秒（包含排队）；超过时限会明确失败，原笔记保留。费用未知，以供应商账单为准。
              </p>
              {[...tasks].reverse().map((t: Obj) => (
                <div className="task-card" key={t.id}>
                  <div className="row between">
                    <strong>
                      {t.type === "template"
                        ? "AI 起草模板"
                        : t.type === "preview"
                          ? "模板预览"
                          : t.lane === "live"
                            ? "本段整理"
                            : "整课整理"}
                    </strong>
                    <span className={"task-status " + t.state}>
                      {statusNames[t.state]}
                    </span>
                  </div>
                  <p>
                    尝试 {t.attempt} 次 ·{" "}
                    {t.lane === "live" ? "课堂优先" : "后台"} ·{" "}
                    {new Date(t.createdAt).toLocaleTimeString()}{" "}
                    {t.firstContentMs !== null &&
                      t.firstContentMs !== undefined &&
                      `· 首批预览 ${(t.firstContentMs / 1000).toFixed(1)} 秒`}
                  </p>
                  {t.error && <div className="inline-error">{t.error}</div>}
                  {t.preview && t.state === "running" && (
                    <div className="preview-box">
                      <small>未验证预览</small>
                      <pre>{t.preview}</pre>
                    </div>
                  )}
                  {t.result &&
                    t.type === "preview" &&
                    t.result.blocks.map((b: Obj, i: number) => (
                      <Markdown key={i}>{b.content_md}</Markdown>
                    ))}
                  <div className="row">
                    {["failed", "cancelled"].includes(t.state) && (
                      <button
                        className="secondary compact"
                        onClick={() => void call("task.retry", { id: t.id })}
                      >
                        <RefreshCw size={13} />
                        重试原任务
                      </button>
                    )}
                    {["running", "queued"].includes(t.state) && (
                      <button
                        className="text-button"
                        onClick={() => void call("task.cancel", { id: t.id })}
                      >
                        取消
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!tasks.length && (
                <p className="muted">
                  尚无任务。提交转录后，可在这里查看状态与重试。
                </p>
              )}
            </>
          )}
          {modal === "candidates" && (
            <>
              {candidates.map((c: Obj) => {
                const t = topics.find((t: Obj) => t.id === c.topicId);
                return (
                  <div className="candidate-card" key={c.id}>
                    <div className="row between">
                      <h3>{t.title}</h3>
                      <span className="tiny-badge">{c.reason}</span>
                    </div>
                    <div className="comparison">
                      <div>
                        <h4>当前笔记 · v{t.version}</h4>
                        <Markdown>{t.body || "（空白）"}</Markdown>
                      </div>
                      <div>
                        <h4>AI 建议 · 基于 v{c.baseVersion}</h4>
                        <Markdown>{c.body}</Markdown>
                      </div>
                    </div>
                    {t.version !== c.baseVersion && (
                      <p className="inline-error">
                        当前笔记已变化。请重新生成，旧候选不能覆盖新版本。
                      </p>
                    )}
                    <div className="row end">
                      <button
                        className="text-button"
                        onClick={() =>
                          void call("candidate.reject", { id: c.id })
                        }
                      >
                        拒绝
                      </button>
                      <button
                        className="primary compact"
                        disabled={t.version !== c.baseVersion}
                        onClick={() =>
                          void call("candidate.apply", {
                            id: c.id,
                            version: t.version,
                          })
                        }
                      >
                        <Check size={14} />
                        应用此主题
                      </button>
                    </div>
                  </div>
                );
              })}
              {!candidates.length && <p>没有待确认的候选。</p>}
            </>
          )}
          {modal === "history" && (
            <>
              {topic ? (
                <>
                  <p className="modal-description">
                    {topic.title} · 当前 v{topic.version}
                    。恢复会创建新版本，不会删除历史。
                  </p>
                  {[...s.revisions]
                    .reverse()
                    .filter((r: Obj) => r.topicId === tid)
                    .map((r: Obj) => (
                      <details className="history-item" key={r.id}>
                        <summary>
                          v{r.version} ·{" "}
                          {r.human ? "人工编辑" : "AI / 初始版本"}
                          <span>{new Date(r.createdAt).toLocaleString()}</span>
                        </summary>
                        <Markdown>{r.body || "（空白）"}</Markdown>
                        <button
                          className="secondary compact"
                          onClick={() =>
                            void call("note.restore", {
                              revisionId: r.id,
                              version: topic.version,
                            })
                          }
                        >
                          恢复此版本
                        </button>
                      </details>
                    ))}
                </>
              ) : (
                <p>先选择一个知识主题。</p>
              )}
            </>
          )}
          {modal === "manage" && course && (
            <>
              <p className="modal-description">
                删除「{course.name}
                」会清理本机的课次、录音、材料和笔记历史。自行导出的文件不受影响。
              </p>
              <InputForm
                placeholder="输入完整课程名称确认删除"
                button="删除课程"
                onSubmit={(value) =>
                  void run(async () => {
                    await invoke("course.delete", { id: cid, confirm: value });
                    setModal("");
                    setCid("");
                  })
                }
              />
              <hr />
              <button
                className="secondary"
                onClick={() =>
                  void run(async () => {
                    const data = await invoke("audio.import", {
                      lessonId: lid,
                    });
                    if (!data) return;
                    setNotice("正在解码导入音频…");
                    const ac = new AudioContext({ sampleRate: 24000 });
                    try {
                      const buffer = await ac.decodeAudioData(
                        new Uint8Array(data.data).buffer,
                      );
                      const pcm = new Int16Array(buffer.length);
                      for (let n = 0; n < buffer.length; n++) {
                        let val = 0;
                        for (let c = 0; c < buffer.numberOfChannels; c++)
                          val +=
                            buffer.getChannelData(c)[n] /
                            buffer.numberOfChannels;
                        pcm[n] = Math.round(
                          Math.max(-1, Math.min(1, val)) * 32767,
                        );
                      }
                      await invoke("audio.store", {
                        lessonId: lid,
                        pcm: pcm.buffer,
                      });
                      setNotice("音频已导入，可点击底部“补转写”。");
                    } finally {
                      await ac.close();
                    }
                  })
                }
              >
                <Headphones size={16} />
                导入 MP3 / WAV 音频
              </button>
            </>
          )}
          {modal === "retranscribe" && (
            <div className="retranscribe-form">
              {asrBackend === "local" ? (
                <>
                  <p className="modal-description">
                    将使用当前本地模型“{localAsr.modelName || "SenseVoiceSmall INT8"}”复制本课原始音频，创建一个新的课次并重新识别。原课次的音频、转录和笔记都会保留；本操作不会上传音频。
                  </p>
                  <p className="help">
                    确认后会创建并选中新课次，识别会在后台继续。识别按低能量停顿取约 12–20 秒语段，推理速度取决于模型和电脑。
                  </p>
                </>
              ) : (
                <>
                  <p className="modal-description">
                    确认后会将本课原录音发送至
                    {s.config.asrProvider === "tingwu"
                      ? "阿里云通义听悟"
                      : "当前云端语音服务"}
                    ，生成一个新的课次并重新转写。原课次的音频、转录和笔记都会保留，云端处理可能产生费用；只有点击下面的确认按钮后才会上传。
                  </p>
                  <p className="help">
                    云端重新转写需要真实 API、有效凭据和本课音频授权；确认后会创建并选中新课次，云端转写会在后台继续。
                  </p>
                </>
              )}
              {!retranscribeReady && (
                <p className="inline-error">
                  {asrBackend === "local"
                    ? "请先在本地 ASR 设置中安装并加载当前模型。"
                    : "请先保存真实云端语音配置，并为本课保存音频授权。"}
                </p>
              )}
              <div className="row end">
                <button className="secondary" onClick={() => setModal("")}>取消</button>
                <button
                  className="primary"
                  disabled={busy || !retranscribeReady}
                  onClick={() =>
                    void run(async () => {
                      const result = await invoke("audio.retranscribe", {
                        lessonId: lid,
                      });
                      if (!result?.lessonId)
                        throw new Error("重新转写未返回新课次");
                      setLid(result.lessonId);
                      setTid("");
                      setModal("");
                      setNotice(
                        asrBackend === "local"
                          ? "已创建新课次，正在使用当前本地模型重新转写。"
                          : "已创建新课次，正在提交云端重新转写任务。",
                      );
                    })
                  }
                >
                  确认并创建新课次
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      <button className="empty-action" onClick={onAction}>
        {action}
        <ArrowUpRight size={13} />
      </button>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" title="关闭对话框" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
function InputForm({
  onSubmit,
  multiline = false,
  placeholder = "",
  initial = "",
  button = "保存",
}: {
  onSubmit: (s: string) => void;
  multiline?: boolean;
  placeholder?: string;
  initial?: string;
  button?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value);
      }}
    >
      {multiline ? (
        <textarea
          autoFocus
          className="form-textarea"
          rows={8}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          autoFocus
          className="form-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <div className="row end mt20">
        <button className="primary" disabled={!value.trim()}>
          {button}
        </button>
      </div>
    </form>
  );
}
function MaterialPanel({
  kind,
  title,
  subtitle,
  materials,
  range,
  onImport,
  onRange,
  onError,
}: {
  kind: string;
  title: string;
  subtitle: string;
  materials: Obj[];
  range: Obj;
  onImport: () => void;
  onRange: (r: any) => void;
  onError: (s: string) => void;
}) {
  const [doc, setDoc] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [zoom, setZoom] = useState(100);
  const canvas = useRef<HTMLCanvasElement>(null);
  const material = materials.find((m) => m.id === range?.id),
    page = range?.from || 1;
  useEffect(() => {
    let disposed = false,
      loaded: any;
    setDoc(null);
    if (material?.ext !== ".pdf") return;
    setLoading(true);
    invoke("material.read", { id: material.id })
      .then(
        (bytes) => pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise,
      )
      .then((pdf) => {
        loaded = pdf;
        if (!disposed) setDoc(pdf);
        else pdf.destroy();
      })
      .catch((e) => onError(e.message))
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      loaded?.destroy();
    };
  }, [material?.id]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false,
      task: any;
    doc
      .getPage(page)
      .then((p: any) => {
        if (cancelled || !canvas.current) return;
        const viewport = p.getViewport({ scale: (zoom / 100) * 1.15 }),
          c = canvas.current;
        c.width = viewport.width;
        c.height = viewport.height;
        task = p.render({ canvasContext: c.getContext("2d"), viewport });
        return task.promise;
      })
      .catch((e: any) => {
        if (e.name !== "RenderingCancelledException") onError(e.message);
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom]);
  return (
    <section className="panel material-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span
            className={"panel-symbol " + (kind === "slides" ? "blue" : "amber")}
          >
            {kind === "slides" ? <Layers size={17} /> : <BookOpen size={17} />}
          </span>
          <h2>{title}</h2>
          {!material && (
            <span className="muted small">
              {kind === "book" ? "可选" : "PDF"}
            </span>
          )}
        </div>
        <button className="icon-btn" title={"导入" + title} onClick={onImport}>
          <Upload size={16} />
        </button>
      </div>
      {material ? (
        <>
          <div className="document-toolbar">
            <select
              aria-label={title + "文件"}
              value={material.id}
              onChange={(e) => onRange({ id: e.target.value, from: 1, to: 1 })}
            >
              {materials
                .filter((m) => m.kind === kind && m.ext === ".pdf")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <button
              className="text-button small"
              onClick={() => setZoom((z) => (z === 100 ? 130 : 100))}
            >
              {zoom}%
            </button>
          </div>
          <div className="pdf-scroll">
            {loading ? <p>正在打开 PDF…</p> : <canvas ref={canvas} />}
          </div>
          <div className="document-footer">
            <button
              className="icon-btn"
              title="上一页"
              disabled={page <= 1}
              onClick={() =>
                onRange({ ...range, from: page - 1, to: page - 1 })
              }
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              第{" "}
              <input
                type="number"
                aria-label={title + "页码"}
                min={1}
                max={doc?.numPages || 1}
                value={page}
                onChange={(e) => {
                  const p = Number(e.target.value);
                  if (p >= 1 && p <= (doc?.numPages || 1))
                    onRange({ ...range, from: p, to: Math.max(p, range.to) });
                }}
              />{" "}
              / {doc?.numPages || material.pages.length} 页
            </span>
            <button
              className="icon-btn"
              title="下一页"
              disabled={page >= (doc?.numPages || 1)}
              onClick={() =>
                onRange({ ...range, from: page + 1, to: page + 1 })
              }
            >
              <ChevronRight size={15} />
            </button>
            <label>
              发送到第{" "}
              <input
                aria-label={title + "范围结束页"}
                type="number"
                min={page}
                max={doc?.numPages || 1}
                value={range.to}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= page && n <= (doc?.numPages || 1))
                    onRange({ ...range, to: n });
                }}
              />{" "}
              页
            </label>
          </div>
        </>
      ) : (
        <Empty
          icon={
            kind === "slides" ? <Layers size={30} /> : <BookOpen size={30} />
          }
          title={
            kind === "slides" ? "把课件放进课堂" : "多一份参考，多一层理解"
          }
          description={
            kind === "slides"
              ? "导入 PDF 课件，边听边看，手动关联当前页。"
              : "教材不是必选项，你随时可以补充。"
          }
          action={kind === "slides" ? "导入课程课件" : "添加参考教材"}
          onAction={onImport}
        />
      )}
      <span className="sr-only">{subtitle}</span>
    </section>
  );
}
function NoteEditor({
  topic,
  flushRef,
  onError,
  onSaved,
  onSource,
}: {
  topic: Obj;
  flushRef: React.MutableRefObject<() => Promise<void>>;
  onError: (s: string) => void;
  onSaved: () => Promise<void>;
  onSource: (r: Obj) => void;
}) {
  const [body, setBody] = useState(topic.body),
    [editing, setEditing] = useState(false),
    [saved, setSaved] = useState(true),
    [saving, setSaving] = useState(false);
  const current = useRef({
      body: topic.body,
      version: topic.version,
      dirty: false,
    }),
    pending = useRef<Promise<void> | null>(null);
  const save = useCallback(async () => {
    if (pending.current) await pending.current;
    const draft = current.current;
    if (!draft.dirty) return;
    const value = draft.body,
      version = draft.version;
    setSaving(true);
    const promise = (async () => {
      try {
        const t = await invoke("note.save", {
          topicId: topic.id,
          version,
          body: value,
        });
        current.current.version = t.version;
        if (current.current.body === value) {
          current.current.dirty = false;
          setSaved(true);
        }
        await onSaved();
      } catch (e) {
        onError((e as Error).message);
        throw e;
      } finally {
        setSaving(false);
        pending.current = null;
      }
    })();
    pending.current = promise;
    await promise;
  }, [topic.id]);
  useEffect(() => {
    flushRef.current = save;
    return () => {
      flushRef.current = async () => {};
    };
  }, [save]);
  useEffect(() => {
    if (!current.current.dirty && !pending.current) {
      current.current = {
        body: topic.body,
        version: topic.version,
        dirty: false,
      };
      setBody(topic.body);
      setSaved(true);
    }
  }, [topic.version]);
  useEffect(() => {
    if (!saved) {
      const timer = setTimeout(() => void save().catch(() => {}), 800);
      return () => clearTimeout(timer);
    }
  }, [body, saved, save]);
  return (
    <>
      <div className="note-toolbar">
        <span className={saved ? "save-label" : "muted"}>
          {saving ? (
            "保存中…"
          ) : saved ? (
            <>
              <CheckCircle2 size={12} />
              已保存 · v{topic.version}
            </>
          ) : (
            "待保存"
          )}
          {topic.human && " · 人工内容受保护"}
          {topic.stale && " · 来源已更新"}
        </span>
        <div className="segmented mini">
          <button
            className={!editing ? "selected" : ""}
            onClick={() => {
              void save()
                .then(() => setEditing(false))
                .catch(() => {});
            }}
          >
            阅读
          </button>
          <button
            className={editing ? "selected" : ""}
            onClick={() => setEditing(true)}
          >
            编辑
          </button>
        </div>
      </div>
      <div className="note-scroll">
        {!saved && topic.version !== current.current.version && (
          <div className="inline-error">
            笔记已更新，你的草稿仍在编辑器中。
            <button
              className="secondary compact"
              onClick={() => {
                current.current.version = topic.version;
                void save().catch(() => {});
              }}
            >
              将我的草稿保存为新版本（保留历史）
            </button>
          </div>
        )}
        {editing ? (
          <textarea
            className="note-editor"
            aria-label="Markdown 笔记编辑器"
            value={body}
            onChange={(e) => {
              const v = e.target.value;
              setBody(v);
              current.current.body = v;
              current.current.dirty = true;
              setSaved(false);
            }}
            onBlur={() => void save().catch(() => {})}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key === "s") {
                e.preventDefault();
                void save().catch(() => {});
              }
            }}
            placeholder="用 Markdown 写下你的理解…"
          />
        ) : body ? (
          <Markdown>{body}</Markdown>
        ) : (
          <div className="note-empty">
            <span>01 / {topic.title}</span>
            <h3>从一个想法开始。</h3>
            <p>点击「编辑」写下笔记，或提交课堂转录生成第一份草稿。</p>
          </div>
        )}
        {topic.sources.length > 0 && (
          <div className="sources">
            <h4>笔记来源</h4>
            {topic.sources.map((r: Obj, i: number) => (
              <button key={i} onClick={() => onSource(r)}>
                <span>{i + 1}</span>
                {r.kind === "material"
                  ? `${r.name} · 第 ${r.page} 页`
                  : r.startMs === null
                    ? `课堂转录 · 第 ${r.paragraph} 段`
                    : `课堂转录 · ${clock(r.startMs)}`}
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
function SettingsForm({
  config,
  localAsr,
  course,
  lessonId,
  onRun,
  onClose,
}: {
  config: Obj;
  localAsr?: Obj;
  course: Obj;
  lessonId: string;
  onRun: (fn: () => Promise<any>, save?: boolean) => Promise<any>;
  onClose: () => void;
}) {
  const configuredBackend =
    config.asrBackend === "local" || config.backend === "local"
      ? "local"
      : "cloud";
  const localState = { ...fallbackLocalAsr, ...(localAsr || {}) };
  const localStateValue = String(
    localState.state || (localState.ready ? "ready" : "missing"),
  );
  const localStateReady = Boolean(
    localState.ready || localStateValue === "ready",
  );
  const localStateName =
    localAsrStateNames[localStateValue] ||
    (localStateReady ? "已就绪" : "状态未知");
  const progress = Math.max(
    0,
    Math.min(100, Number(localState.progress) || 0),
  );
  const localModels =
    Array.isArray(localState.models) && localState.models.length
      ? localState.models
      : fallbackLocalAsr.models;
  const selectedModelId = String(
    localState.modelId || localModels[0]?.id || "sensevoice",
  );
  const selectedModel =
    localModels.find((model: Obj) => String(model.id) === selectedModelId) ||
    localModels[0];
  const [v, setV] = useState<Obj>(() => ({
      ...config,
      textKey: "",
      asrKey: "",
      asrBackend: configuredBackend,
      asrProvider: config.asrProvider || "openai",
    })),
    [asrBackendDraft, setAsrBackendDraft] = useState<"local" | "cloud">(
      configuredBackend,
    ),
    [consent, setConsent] = useState({
      text:
        (course?.consent.text && course?.consent.version === config.version) ||
        false,
      audio:
        (course?.consent.audio && course?.consent.version === config.version) ||
        false,
    }),
    [message, setMessage] = useState(""),
    [localAction, setLocalAction] = useState(""),
    [localMessage, setLocalMessage] = useState(""),
    [localTest, setLocalTest] = useState<Obj | null>(null),
    [modelDraft, setModelDraft] = useState(selectedModelId),
    [terms, setTerms] = useState(String(course?.asrTerms || ""));
  useEffect(() => {
    const backend =
      config.asrBackend === "local" || config.backend === "local"
        ? "local"
        : "cloud";
    setAsrBackendDraft(backend);
    setV((current) => ({ ...current, asrBackend: backend }));
  }, [config.asrBackend, config.backend]);
  useEffect(() => {
    setModelDraft(selectedModelId);
  }, [selectedModelId]);
  useEffect(() => {
    setTerms(String(course?.asrTerms || ""));
  }, [course?.asrTerms]);
  const field = (
    k: string,
    label: string,
    placeholder = "",
    password = false,
  ) => (
    <label>
      {label}
      <input
        type={password ? "password" : "text"}
        value={v[k] ?? ""}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
      />
    </label>
  );
  const runLocal = async (method: string, args: Obj = {}) => {
    setLocalAction(method);
    setLocalMessage("");
    let result: any = null;
    try {
      result = await onRun(() => invoke(method, args), false);
    } finally {
      setLocalAction("");
    }
    if (result === null) {
      setLocalMessage("操作失败，请查看右下角提示后重试。");
    }
    return result;
  };
  const selectModel = async (modelId: string) => {
    if (modelId === selectedModelId) return;
    const previous = modelDraft;
    setModelDraft(modelId);
    const result = await runLocal("localAsr.select", { modelId });
    if (result === null) {
      setModelDraft(previous);
      return;
    }
    setLocalTest(null);
    setLocalMessage(
      modelId === "qwen3"
        ? "已选择 Qwen3-ASR-0.6B INT8，课堂术语提示仅作辅助。"
        : "已选择 SenseVoiceSmall INT8，适合较快的 CPU 识别。",
    );
  };
  const termCount = terms
    .split(/[\n,，]/)
    .map((term) => term.trim())
    .filter(Boolean).length;
  const saveTerms = async () => {
    if (terms.length > 1000) {
      setLocalMessage("课程术语最多 1000 个字符。");
      return;
    }
    if (termCount > 80) {
      setLocalMessage("课程术语最多 80 个，请合并或删除重复项。");
      return;
    }
    const result = await runLocal("localAsr.terms", { lessonId, terms });
    if (result !== null) {
      setLocalMessage(
        terms.trim()
          ? "课程术语已保存，仅对 Qwen3-ASR 提供提示，不能保证识别一定正确。"
          : "课程术语已清空。",
      );
    }
  };
  const safeHost = (url: unknown, fallback: string) => {
    if (typeof url !== "string" || !url.trim()) return fallback;
    try {
      return new URL(url).host;
    } catch {
      return fallback;
    }
  };
  const localInstallBusy =
    localAction === "localAsr.install" || localStateValue === "downloading";
  return (
    <div className="settings-form">
      <p className="modal-description">
        文本和语音可使用不同服务商。API 密钥由 Windows
        账户加密后保存在本机，不会返回界面。填写完整端点地址；更换文本配置后需要重新授权课程。
      </p>
      <div className="settings-section local-asr-settings">
        <h3>
          <Mic size={16} />
          本地语音识别 <span>{selectedModel?.name || "SenseVoiceSmall INT8"} · CPU 离线</span>
        </h3>
        <p className="help local-asr-help">
          录音约每 5 秒落盘，识别会按约 12–20 秒并结合低能量停顿取边界，不是逐字实时流式识别；首次加载通常更慢，速度取决于硬件，Qwen3-ASR 可能带来更高的 CPU 延迟。模型按需下载，首次安装需要网络，安装后可离线使用；音频始终留在本机。只有你勾选文本授权后，转录文字才会发送给云端整理，文本 API 可以不配置。
        </p>
        <div className="asr-backend-row">
          <div>
            <strong>语音识别后端</strong>
            <span>此设置独立于“工作模式”，不会改变文本生成配置或课程授权。</span>
          </div>
          <div className="segmented asr-choice" role="group" aria-label="选择语音识别后端">
            <button
              className={asrBackendDraft === "local" ? "selected" : ""}
              onClick={() => setAsrBackendDraft("local")}
            >
              本机离线
            </button>
            <button
              className={asrBackendDraft === "cloud" ? "selected" : ""}
              onClick={() => setAsrBackendDraft("cloud")}
            >
              云端 API
            </button>
          </div>
        </div>
        <div className="asr-model-picker">
          <div className="row between">
            <div>
              <strong>本地模型</strong>
              <span>切换模型会独立保存；只对之后的识别分片生效。</span>
            </div>
            <span className="tiny-badge">当前：{selectedModel?.name || "SenseVoiceSmall INT8"}</span>
          </div>
          <div className="asr-model-options" role="group" aria-label="选择本地识别模型">
            {localModels.map((model: Obj) => {
              const id = String(model.id);
              const active = id === modelDraft;
              const size = Number(model.downloadMB) || (id === "qwen3" ? 987 : 240);
              const sizeLabel = size >= 900 ? "约 1 GB" : "约 " + Math.round(size) + " MB";
              return (
                <button
                  type="button"
                  key={id}
                  className={"asr-model-option " + (active ? "selected" : "")}
                  aria-pressed={active}
                  disabled={localAction !== "" || active}
                  onClick={() => void selectModel(id)}
                >
                  <span className="asr-model-option-copy">
                    <strong>{model.name || id}</strong>
                    <small>
                      {id === "qwen3"
                        ? "较大模型 · 约 1 GB，CPU 延迟较高"
                        : "快速 · CPU 延迟较低"}
                    </small>
                  </span>
                  <span className="asr-model-option-size">
                    {model.ready ? "已安装" : "下载 " + sizeLabel}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="help asr-model-help">
            Qwen3-ASR 可能提高课堂术语覆盖，但模型更大、CPU 延迟更高；识别效果受录音和环境影响，不保证一定正确。
          </p>
        </div>
        <div className="local-asr-model-card">
          <div className="row between">
            <div>
              <strong>{localState.modelName || "SenseVoiceSmall INT8"}</strong>
              <span className={"asr-state " + localStateValue}>
                <span className={"dot " + (localStateReady ? "green" : "")} />
                {localStateName}
              </span>
            </div>
            {localState.queued > 0 && (
              <span className="tiny-badge">排队 {localState.queued}</span>
            )}
          </div>
          {localStateValue === "downloading" && (
            <div className="asr-progress" aria-label={"模型下载进度 " + progress + "%"}>
              <span style={{ width: String(progress) + "%" }} />
            </div>
          )}
          {localStateValue === "error" && localState.error && (
            <p className="inline-error">
              {localStateReady ? "本次本地识别出错：" : "模型下载失败："}{localState.error}
            </p>
          )}
          {localState.modelDir && (
            <p className="model-dir" title={localState.modelDir}>
              模型目录：{localState.modelDir}
            </p>
          )}
          <div className="row local-asr-actions">
            <button
              className="primary compact"
              disabled={localInstallBusy || localStateReady}
              onClick={() =>
                void runLocal("localAsr.install").then((result) => {
                  if (result !== null) setLocalMessage("模型已下载并安装；安装后可离线使用。")
                })
              }
            >
              <Download size={14} />
              {localInstallBusy
                ? "正在下载…"
                : localStateReady
                  ? "已安装"
                  : localStateValue === "error"
                    ? "重试下载"
                    : "下载模型"}
            </button>
            <button
              className="secondary compact"
              disabled={localAction !== ""}
              onClick={() =>
                void runLocal("localAsr.status").then((result) => {
                  if (result !== null) setLocalMessage("状态已刷新。")
                })
              }
            >
              <RefreshCw size={13} />
              刷新状态
            </button>
            <button
              className="secondary compact"
              disabled={localAction !== ""}
              onClick={() =>
                void runLocal("localAsr.openModelPage").then((result) => {
                  if (result !== null) setLocalMessage("已打开模型来源页面。")
                })
              }
            >
              <ArrowUpRight size={13} />
              查看模型来源
            </button>
            <button
              className="text-button compact"
              disabled={localAction !== ""}
              onClick={() =>
                void runLocal("localAsr.openFolder").then((result) => {
                  if (result !== null) setLocalMessage("已打开模型目录。")
                })
              }
            >
              <Folder size={13} />
              打开模型目录
            </button>
          </div>
        </div>
        <div className="asr-terms-box">
          <label className="asr-terms-field">
            <span>
              课程术语（仅 Qwen3-ASR 生效）
              <small>{termCount}/80 个 · {terms.length}/1000 字符</small>
            </span>
            <textarea
              value={terms}
              maxLength={1000}
              rows={3}
              placeholder="NP,NP完全,3-SAT,CLIQUE,非确定性图灵机"
              onChange={(e) => setTerms(e.target.value)}
            />
          </label>
          <div className="row between asr-terms-foot">
            <span className="help">
              每行或逗号一个；术语只作提示，可能仍识别错误，不会硬替换文字。保存时如正在识别，请先暂停或等当前分片完成。
            </span>
            <button
              className="secondary compact"
              disabled={localAction !== ""}
              onClick={() => void saveTerms()}
            >
              <Check size={13} />
              保存课程术语
            </button>
          </div>
        </div>
        <div className="row between asr-save-row">
          <button
            className="primary"
            disabled={localAction !== ""}
            onClick={() =>
              void runLocal("localAsr.configure", {
                backend: asrBackendDraft,
              }).then((result) => {
                if (result !== null) {
                  setMessage(
                    asrBackendDraft === "local"
                      ? "已启用本机离线识别。"
                      : "已切换为云端语音识别。",
                  );
                }
              })
            }
          >
            <CheckCircle2 size={15} />
            保存语音识别设置
          </button>
          {localMessage && <span className="help asr-action-message">{localMessage}</span>}
        </div>
        <div className="local-asr-test">
          <div className="row between">
            <div>
              <strong>真实模型测试</strong>
              <span>使用随模型下载的约 5 秒示例音频，不发送到网络。</span>
            </div>
            <button
              className="secondary compact"
              disabled={!localStateReady || localAction !== ""}
              onClick={() =>
                void runLocal("localAsr.test").then((result) => {
                  if (result !== null) setLocalTest(result || null);
                })
              }
            >
              <Headphones size={14} />
              {localAction === "localAsr.test" ? "测试中…" : "测试本地模型"}
            </button>
          </div>
          {localTest && (
            <div className="local-asr-test-result">
              <p>{localTest.text || "（模型没有返回文字）"}</p>
              <span>
                音频 {Number(localTest.audioSeconds || 0).toFixed(1)} 秒 · 用时 {Math.round(Number(localTest.elapsedMs) || 0)} 毫秒
              </span>
            </div>
          )}
        </div>
      </div>
      <label>
        工作模式
        <select
          value={v.mode}
          onChange={(e) => setV({ ...v, mode: e.target.value })}
        >
          <option value="off">关闭云端 AI · 本地转写仍可用</option>
          <option value="http">真实 API · 云端语音与文本 AI</option>
          <option value="mock">模拟 · 仅用于功能演示</option>
        </select>
      </label>
      <div className="settings-section">
        <h3>
          <Sparkles size={16} />
          文本生成 <span>Chat Completions 兼容协议 · SSE / JSON</span>
        </h3>
        {field(
          "textUrl",
          "完整请求地址",
          "https://your-provider/v1/chat/completions",
        )}
        <div className="form-grid">
          {field("textModel", "模型名称", "填写服务商提供的模型 ID")}
          {field(
            "textKey",
            "API 密钥",
            config.hasTextKey ? "已保存，留空保留" : "sk-…",
            true,
          )}
        </div>
      </div>
      {asrBackendDraft === "cloud" ? (
        <div className="settings-section cloud-asr-settings">
          <h3>
            <Mic size={16} />
            云端语音识别 <span>选择提供商与实时转写协议</span>
          </h3>
          <label>
            语音提供商
            <select
              value={v.asrProvider || "openai"}
              onChange={(e) => setV({ ...v, asrProvider: e.target.value })}
            >
              <option value="openai">OpenAI Realtime 兼容接口</option>
              <option value="tingwu">阿里云 · 通义听悟</option>
            </select>
          </label>
          {v.asrProvider === "tingwu" ? (
            <>
              <p className="help">
                在听悟控制台开通实时记录并创建项目。填写项目 AppKey、AccessKey ID 和 AccessKey Secret；凭据由主进程加密保存。实时字幕与本地录音同时工作，听悟端点由应用配置。
              </p>
              {field("tingwuAppKey", "听悟项目 AppKey", "听悟控制台 → 我的项目")}
              <div className="form-grid">
                {field(
                  "tingwuId",
                  "AccessKey ID",
                  config.hasTingwuId
                    ? "已保存，留空保留"
                    : "RAM 用户 AccessKey ID",
                  true,
                )}
                {field(
                  "tingwuSecret",
                  "AccessKey Secret",
                  config.hasTingwuSecret
                    ? "已保存，留空保留"
                    : "AccessKey Secret",
                  true,
                )}
              </div>
              <label>
                识别语种
                <select
                  value={v.tingwuLanguage || "cn"}
                  onChange={(e) =>
                    setV({ ...v, tingwuLanguage: e.target.value })
                  }
                >
                  <option value="cn">中文</option>
                  <option value="fspk">中英文自由说</option>
                  <option value="en">英文</option>
                  <option value="yue">粤语</option>
                  <option value="ja">日语</option>
                </select>
              </label>
              <p className="help">
                听悟只负责语音转写，笔记继续使用上方文本服务。补转写通过听悟按音频时长推流，无需 OSS；请先停止本课录音并保持应用打开。
              </p>
            </>
          ) : (
            <>
              <p className="help">
                实时采用 OpenAI Realtime 转录事件协议，24 kHz PCM；HTTP 文本接口兼容不代表语音接口兼容。厂商专有协议需适配后使用。
              </p>
              {field("asrUrl", "实时 WSS 地址")}
              <div className="form-grid">
                {field("asrModel", "实时转录模型")}
                {field(
                  "asrKey",
                  "语音 API 密钥",
                  config.hasAsrKey ? "已保存，留空保留" : "可与文本服务不同",
                  true,
                )}
              </div>
              {field("fileUrl", "补转写 / 文件转写 HTTP 地址")}
              {field("fileModel", "文件转写模型", "用于断线补传")}
            </>
          )}
        </div>
      ) : (
        <p className="help cloud-asr-note">
          当前使用本机语音识别；云端语音提供商配置已保留，切换到云端后可继续编辑。
        </p>
      )}
      <div className="form-grid">
        <label>
          每课最大调用次数
          <input
            type="number"
            min={1}
            max={10000}
            value={v.maxCalls}
            onChange={(e) => setV({ ...v, maxCalls: Number(e.target.value) })}
          />
        </label>
        <label>
          单次最大输出 tokens
          <input
            type="number"
            min={256}
            max={16000}
            value={v.maxOutput}
            onChange={(e) => setV({ ...v, maxOutput: Number(e.target.value) })}
          />
        </label>
      </div>
      {field("policy", "供应商数据保留说明 / 政策链接")}
      <p className="help">
        此上限控制文本及文件转写调用次数，不能视为金额上限；实时语音按连接音频计费，请同时在供应商后台设置预算。
      </p>
      <button
        className="primary"
        onClick={() =>
          void onRun(async () => {
            await invoke("provider.configure", {
              ...v,
              // 文本设置保存时保留独立的语音后端选择。
              asrBackend: configuredBackend,
            });
            setConsent({ text: false, audio: false });
            setMessage("配置已保存。请重新勾选下面的课程授权。");
          })
        }
      >
        保存 API 配置
      </button>
      {message && <p className="success-message">{message}</p>}
      {asrBackendDraft === "cloud" && !!config.pendingTingwuTasks && (
        <div className="consent-box tingwu-pending-box">
          <p>
            有 {config.pendingTingwuTasks} 个通义听悟云端任务尚未确认结束。停止录音与补转写后可重试结束；更换项目、凭据或删除课程前请先处理。
          </p>
          <button
            className="secondary"
            onClick={() =>
              void onRun(async () => {
                const result = await invoke("provider.tingwuCleanup");
                setMessage("已结束 " + result.count + " 个听悟任务");
              })
            }
          >
            重试结束云端任务
          </button>
        </div>
      )}
      {course && (
        <div className="consent-box">
          <h3>
            <ShieldCheck size={17} />
            当前课程授权 · {course.name}
          </h3>
          <p>
            文本发送目标：
            {config.mode === "http"
              ? safeHost(config.textUrl, "未配置文本地址")
              : "离线 / 模拟模式"}
            ；语音：
            {configuredBackend === "local"
              ? "本机离线模型（音频不离开电脑）"
              : config.asrProvider === "tingwu"
                ? "阿里云通义听悟 · 北京"
                : safeHost(config.asrUrl, "未配置云端语音地址")}
            。范围仅包含本课转录、当前选定材料页和笔记上下文。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={consent.text}
              onChange={(e) =>
                setConsent({ ...consent, text: e.target.checked })
              }
            />
            允许发送转录、选定材料和笔记，用于整理与模板起草
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={consent.audio}
              onChange={(e) =>
                setConsent({ ...consent, audio: e.target.checked })
              }
            />
            允许发送麦克风音频与本课待补转写分片
          </label>
          <div className="row">
            {configuredBackend === "cloud" &&
              config.asrProvider === "tingwu" && (
                <button
                  className="secondary"
                  onClick={() =>
                    void onRun(async () => {
                      await invoke("provider.tingwuTest", { lessonId });
                      setMessage(
                        "听悟鉴权成功，测试任务已结束。开始录音可验证实时字幕。",
                      );
                    })
                  }
                >
                  测试听悟鉴权（可能计费）
                </button>
              )}
            <button
              className="secondary"
              onClick={() =>
                void onRun(async () => {
                  await invoke("lesson.consent", { lessonId, ...consent });
                  setMessage("课程授权已保存");
                })
              }
            >
              保存课程授权
            </button>
            <button
              className="text-button"
              onClick={() =>
                void onRun(async () => {
                  await invoke("provider.test", { lessonId });
                  setMessage(
                    "文本接口测试成功（已发送测试文本，可能产生费用）",
                  );
                })
              }
            >
              发送测试文本（可能计费）
            </button>
          </div>
        </div>
      )}
      <div className="row end">
        <button className="secondary" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
function TemplateForm({
  course,
  courses,
  lessonId,
  tasks,
  onRun,
}: {
  course: Obj;
  courses: Obj[];
  lessonId: string;
  tasks: Obj[];
  onRun: (fn: () => Promise<any>) => Promise<any>;
}) {
  const [rules, setRules] = useState({ ...course.template.rules }),
    [preference, setPreference] = useState(""),
    [sample, setSample] = useState(""),
    [draftId, setDraftId] = useState(""),
    [previewId, setPreviewId] = useState(""),
    [message, setMessage] = useState("");
  const draft = tasks.find((t) => t.id === draftId),
    preview = tasks.find((t) => t.id === previewId);
  return (
    <div className="settings-form">
      <p className="modal-description">
        模板只定义呈现规则。保存后用于新任务，不会改写旧笔记或已排队任务。
      </p>
      <div className="form-grid">
        {[
          ["heading_numbering", "标题编号", ["层级编号", "不编号", "中文序号"]],
          ["detail_level", "详略程度", ["标准", "简洁", "详细"]],
          ["source_format", "来源格式", ["来源列表", "行内引用"]],
          ["image_policy", "图片使用", ["只给链接", "保留原图", "按需插入"]],
        ].map(([k, label, values]) => (
          <label key={String(k)}>
            {label}
            <select
              value={rules[String(k)]}
              onChange={(e) =>
                setRules({ ...rules, [String(k)]: e.target.value })
              }
            >
              {(values as string[]).map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label>
        自定义呈现规则
        <textarea
          rows={4}
          value={rules.custom_prompt}
          onChange={(e) =>
            setRules({ ...rules, custom_prompt: e.target.value })
          }
        />
      </label>
      <div className="row">
        <button
          className="primary"
          onClick={() =>
            void onRun(async () => {
              await invoke("template.save", {
                courseId: course.id,
                version: course.template.version,
                rules,
              });
              setMessage("模板已保存；原有笔记保持原版本。");
            })
          }
        >
          保存模板修订
        </button>
        <button
          className="secondary"
          onClick={() =>
            void onRun(async () => {
              const t = await invoke("template.preview", { lessonId, rules });
              setPreviewId(t.id);
            })
          }
        >
          用本课内容预览
        </button>
      </div>
      {message && <p className="success-message">{message}</p>}
      {preview && (
        <div className="preview-box">
          <b>实际内容预览 · {statusNames[preview.state]}</b>
          {preview.error && <p>{preview.error}</p>}
          {preview.result?.blocks.map((b: Obj, i: number) => (
            <Markdown key={i}>{b.content_md}</Markdown>
          ))}
        </div>
      )}
      <div className="settings-section">
        <h3>
          <Sparkles size={16} />让 AI 起草呈现规则
        </h3>
        <label>
          你的偏好
          <textarea
            rows={2}
            placeholder="例如：适合理工科复习，简短定义，完整推导，标明易错点"
            value={preference}
            onChange={(e) => setPreference(e.target.value)}
          />
        </label>
        <label>
          可选笔记样例（仅提取风格）
          <textarea
            rows={3}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
        </label>
        <button
          className="secondary"
          disabled={!preference.trim()}
          onClick={() =>
            void onRun(async () => {
              const t = await invoke("template.draft", {
                lessonId,
                preference,
                sample,
              });
              setDraftId(t.id);
            })
          }
        >
          <Sparkles size={15} />
          起草模板
        </button>
        {draft && (
          <div className="preview-box">
            <b>{statusNames[draft.state]}</b>
            {draft.error && <p>{draft.error}</p>}
            {draft.result?.rules && (
              <>
                <pre>{JSON.stringify(draft.result.rules, null, 2)}</pre>
                <button
                  className="primary compact"
                  onClick={() => {
                    setRules(draft.result.rules);
                    setMessage("已填入候选规则，请检查并保存。");
                  }}
                >
                  采用规则候选
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <label>
        复制模板到另一课程
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value)
              void onRun(async () => {
                await invoke("template.clone", {
                  from: course.id,
                  to: e.target.value,
                });
                setMessage("已创建独立模板副本");
              });
          }}
        >
          <option value="">选择目标课程…</option>
          {courses
            .filter((c) => c.id !== course.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
