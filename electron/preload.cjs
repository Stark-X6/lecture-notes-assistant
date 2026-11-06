const { contextBridge, ipcRenderer } = require("electron");
const allowed = new Set([
  "snapshot",
  "lesson.update",
  "lesson.delete",
  "notebook.create",
  "conversation.save",
  "study.generate",
  "material.outline",
  "material.outlineSave",
  "topic.structure",
  "note.create",
  "note.saveAnswer",
  "artifact.save",
  "study.export",
  "attachment.import",
  "attachment.read",
  "template.migrate",
  "budget.save",
  "localAsr.status",
  "localAsr.select",
  "localAsr.terms",
  "audio.retranscribe",
  "localAsr.install",
  "localAsr.test",
  "localAsr.configure",
  "localAsr.openFolder",
  "localAsr.openModelPage",
  "course.create",
  "course.delete",
  "lesson.create",
  "lesson.mode",
  "lesson.context",
  "lesson.consent",
  "topic.create",
  "topic.assign",
  "note.save",
  "note.restore",
  "note.export",
  "candidate.apply",
  "candidate.reject",
  "transcript.add",
  "transcript.revise",
  "material.import",
  "material.read",
  "material.index",
  "audio.import",
  "audio.read",
  "audio.backfill",
  "submission.create",
  "task.retry",
  "task.cancel",
  "ai.pause",
  "template.save",
  "template.clone",
  "template.draft",
  "template.preview",
  "provider.configure",
  "provider.test",
  "provider.tingwuCleanup",
  "provider.tingwuTest",
  "recording.start",
  "recording.pause",
  "recording.resume",
  "recording.stop",
  "demo.seed",
  "layout.save",
]);
allowed.add("audio.store");
contextBridge.exposeInMainWorld("desktop", {
  invoke: (method, args = {}) => {
    if (!allowed.has(method)) return Promise.reject(new Error("未知接口"));
    return ipcRenderer.invoke("app:invoke", method, args).then((r) => {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    });
  },
  subscribe: (cb) => {
    const listener = (_, event) => cb(event);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
});
