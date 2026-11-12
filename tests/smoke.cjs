const { fakeMicrophonePermission } = require("./helpers/macos-permission.cjs");
const { _electron: electron } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path");
(async () => {
  const data = path.resolve(".test-data", "smoke-" + Date.now());
  fs.mkdirSync("artifacts", { recursive: true });
  const app = await electron.launch({
    ...(process.env.LECTURE_EXECUTABLE
      ? { executablePath: process.env.LECTURE_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.LECTURE_EXECUTABLE ? [] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: { ...process.env, LECTURE_DATA_DIR: data },
    timeout: 30000,
  });
  try {
    await fakeMicrophonePermission(app);
    const page = await app.firstWindow();
    await page.waitForSelector(".onboarding");
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByText("打开示例课程", { exact: false }).click();
    await page.waitForSelector(".workspace");
    await page.screenshot({ path: "artifacts/workspace.png" });
    const snapshot = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    const lesson = snapshot.lessons[0],
      course = snapshot.courses[0];
    await page.evaluate(
      async ({ config, lid }) => {
        await window.desktop.invoke("localAsr.configure", { backend: "cloud" });
        await window.desktop.invoke("provider.configure", {
          ...config,
          mode: "mock",
          textKey: "",
          asrKey: "",
        });
        await window.desktop.invoke("submission.create", { lessonId: lid });
      },
      { config: snapshot.config, lid: lesson.id },
    );
    await page.getByText("0 个进行中", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".save-label")?.textContent.includes("v1"),
    );
    await page.waitForFunction(() =>
      document.querySelector(".save-label")?.textContent.includes("v1"),
    );
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Markdown 笔记编辑器" })
      .fill("这是我亲自修改的课堂笔记。");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.evaluate(
      (lid) =>
        window.desktop.invoke("submission.create", {
          lessonId: lid,
          all: true,
        }),
      lesson.id,
    );
    await page.waitForSelector(".candidate-badge");
    await page.locator(".candidate-badge").click();
    await page.waitForSelector(".comparison");
    await page.screenshot({ path: "artifacts/candidate.png" });
    await page.getByTitle("关闭对话框").click();
    // Exercise a real PDF through the import dialog, extractor and canvas viewer.
    fs.mkdirSync(data, { recursive: true });
    const pdf = path.join(data, "fixture.pdf");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const content =
      "BT /F1 24 Tf 40 300 Td (Software Engineering) Tj 0 -42 Td /F1 14 Tf (Requirements - Design - Implementation - Verification) Tj ET";
    objects.push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
    let doc = "%PDF-1.4\n",
      offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(doc));
      doc += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(doc);
    doc +=
      `xref\n0 6\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    fs.writeFileSync(pdf, doc);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, pdf);
    await page.getByTitle("导入课程课件").click();
    await page.locator(".pdf-scroll canvas").waitFor();
    await page.waitForTimeout(700);
    const imported = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    if (!imported.materials[0].pages[0].includes("Software"))
      throw new Error("PDF 文本索引失败");
    await page.evaluate(
      async ({ course, lid }) => {
        await window.desktop.invoke("template.save", {
          courseId: course.id,
          version: course.template.version,
          rules: { ...course.template.rules, detail_level: "详细" },
        });
        await window.desktop.invoke("template.draft", {
          lessonId: lid,
          preference: "保留完整推导",
          sample: "",
        });
        await window.desktop.invoke("template.preview", {
          lessonId: lid,
          rules: course.template.rules,
        });
      },
      { course, lid: lesson.id },
    );
    await page.waitForTimeout(1800);
    const exportRoot = path.join(data, "exports");
    fs.mkdirSync(exportRoot);
    await app.evaluate(({ dialog, shell }, dir) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir],
      });
      shell.showItemInFolder = () => {};
    }, exportRoot);
    const exported = await page.evaluate(
      (lid) => window.desktop.invoke("note.export", { lessonId: lid }),
      lesson.id,
    );
    const markdown = fs.readFileSync(path.join(exported, "notes.md"), "utf8");
    if (!markdown.includes("亲自修改")) throw new Error("导出缺少固定版本笔记");
    const citation = markdown.match(/\[\^(source-\d+)\]/)?.[1];
    if (!citation || !markdown.includes(`[^${citation}]:`))
      throw new Error("导出缺少同一文档中的来源脚注");
    if (fs.existsSync(path.join(exported, "sources")))
      throw new Error("导出仍为每条来源创建文件");
    await page.getByRole("button", { name: "开始录音", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".record-indicator")?.classList.contains("live"),
    );
    await page.waitForTimeout(6200);
    const during = await page.evaluate(() => window.desktop.invoke("snapshot"));
    if (
      !during.topics[0].human ||
      during.topics[0].body !== "这是我亲自修改的课堂笔记。"
    )
      throw new Error("人工编辑未保存或被覆盖");
    if (!during.chunks.length) throw new Error("录音未保存任何分片");
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).waitFor();
    const pauseState = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    await page.waitForTimeout(1000);
    const stillPaused = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    if (stillPaused.lessons[0].captureMs !== pauseState.lessons[0].captureMs)
      throw new Error("暂停时间错误计入音频");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.waitForTimeout(1100);
    await page.evaluate(
      (lid) =>
        window.desktop.invoke("ai.pause", { lessonId: lid, paused: true }),
      lesson.id,
    );
    const stoppedAI = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    if (stoppedAI.lessons[0].recording !== "recording")
      throw new Error("停止 AI 中断录音");
    await page.getByTitle("结束并保存录音").click();
    await page
      .getByRole("button", { name: "开始录音", exact: true })
      .waitFor({ timeout: 15000 });
    await page.screenshot({ path: "artifacts/recorded.png" });
    if (errors.length) throw new Error(errors.join("\n"));
    const final = await page.evaluate(() => window.desktop.invoke("snapshot"));
    console.log(
      JSON.stringify(
        {
          ui: "pass",
          tasks: final.tasks.map((t) => t.state),
          audioChunks: final.chunks.length,
          audioMs: final.lessons[0].captureMs,
          candidates: final.candidates.length,
          note: final.topics[0].body,
          data,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
