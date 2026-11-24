const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect } = require("@playwright/test");
const { fakeCredentialStorage } = require("./helpers/macos-vault.cjs");

async function main() {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "lecture-text-providers-"),
  );
  const executablePath = process.env.LECTURE_EXECUTABLE;
  const launch = () =>
    electron.launch({
      executablePath,
      args: executablePath ? [] : ["."],
      env: { ...process.env, LECTURE_DATA_DIR: data },
    });
  let app = await launch();
  try {
    await fakeCredentialStorage(app);
    // Intercept the Electron main process before creating a course or enabling HTTP.
    await app.evaluate(() => {
      globalThis.fixtureRequests = [];
      globalThis.fetch = async (url, request) => {
        const target = String(url);
        const headers = new Headers(request.headers);
        const key = headers.get("x-api-key") || headers.get("authorization");
        const rules = JSON.stringify({ rules: { custom_prompt: "fixture" } });
        const fixtures = {
          "https://api.openai.com/v1/responses": {
            key: "Bearer fixture-openai",
            body: {
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: rules }],
                },
              ],
            },
          },
          "https://api.anthropic.com/v1/messages": {
            key: "fixture-anthropic",
            body: {
              type: "message",
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: rules }],
            },
          },
          "https://gateway.example:8443/v1/chat/completions": {
            key: "Bearer fixture-custom",
            body: {
              choices: [{ message: { content: rules }, finish_reason: "stop" }],
            },
          },
        };
        const fixture = fixtures[target];
        if (!fixture || key !== fixture.key)
          throw new Error("unexpected test destination or credential");
        globalThis.fixtureRequests.push(target);
        return Response.json(fixture.body);
      };
    });
    let page = await app.firstWindow();
    const call = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.desktop.invoke(method, args), {
        method,
        args,
      });
    const snapshot = () => call("snapshot");
    await page.waitForFunction(() => !!window.desktop);
    const course = await call("course.create", { name: "文本服务测试" });
    await page.waitForSelector(".course-space");
    await page.getByRole("button", { name: "API 与设置", exact: true }).click();
    const provider = page.getByLabel("文本提供商", { exact: true });
    const model = page.getByLabel("模型名称", { exact: true });
    const key = page.getByLabel("API 密钥", { exact: true });
    const url = page.getByLabel("完整请求地址", { exact: true });
    const testButton = page.getByRole("button", {
      name: "发送测试文本（可能计费）",
      exact: true,
    });
    async function save() {
      const { config } = await snapshot();
      await page
        .getByRole("button", { name: "保存 API 配置", exact: true })
        .click();
      await expect
        .poll(async () => (await snapshot()).config.version)
        .toBe(config.version + 1);
      await expect(key).toHaveValue("");
    }
    async function authorize() {
      await page
        .getByLabel("允许发送转录、选定材料和笔记", { exact: false })
        .check();
      await page
        .getByRole("button", { name: "保存课程授权", exact: true })
        .click();
      await expect
        .poll(async () => {
          const state = await snapshot();
          const consent = state.courses[0].consent;
          if (consent.text && consent.version === state.config.version)
            return "authorized";
          return {
            provider: state.config.textProvider,
            version: state.config.version,
            consent,
            checked: await page
              .getByLabel("允许发送转录、选定材料和笔记", { exact: false })
              .isChecked(),
            alerts: await page.getByRole("alert").allTextContents(),
          };
        })
        .toBe("authorized");
    }
    async function testRequest(expectedCount) {
      await testButton.click();
      await expect
        .poll(() => app.evaluate(() => globalThis.fixtureRequests.length))
        .toBe(expectedCount);
      await expect
        .poll(async () => (await snapshot()).tasks.at(-1)?.state)
        .toBe("succeeded");
    }

    await page.getByLabel("工作模式").selectOption("http");
    await expect(provider).toHaveValue("openai");
    await expect(url).toHaveValue("https://api.openai.com/v1/responses");
    await expect(url).not.toBeEditable();
    await model.fill("openai-model");
    await key.fill("fixture-openai");
    await save();
    await assert.rejects(
      call("provider.test", { courseId: course.id }),
      /授权/,
    );
    const openaiVersion = (await snapshot()).config.version;
    await authorize();
    await testRequest(1);

    await key.fill("fixture-unsaved-openai");
    await provider.selectOption("anthropic");
    await expect(key).toHaveValue("");
    await expect(model).not.toHaveValue("openai-model");
    await expect(url).toHaveValue("https://api.anthropic.com/v1/messages");
    await expect(testButton).toBeDisabled();
    await model.fill("claude-model");
    await save();
    assert.equal((await snapshot()).config.hasTextKey, false);
    await assert.rejects(
      call("lesson.consent", {
        courseId: course.id,
        text: true,
        configVersion: openaiVersion,
      }),
      /已变化/,
    );
    await assert.rejects(
      call("provider.test", { courseId: course.id }),
      /授权/,
    );
    await authorize();
    await assert.rejects(
      call("provider.test", { courseId: course.id }),
      /密钥/,
    );
    assert.equal(
      await app.evaluate(() => globalThis.fixtureRequests.length),
      1,
    );
    await key.fill("fixture-anthropic");
    await save();
    await authorize();
    await testRequest(2);

    await provider.selectOption("compatible");
    await expect(url).toBeEditable();
    await url.fill("https://gateway.example/chat");
    await key.fill("fixture-unsaved-custom");
    await url.fill("https://gateway.example:8443/v1/chat/completions");
    await expect(key).toHaveValue("");
    await model.fill("custom-model");
    await key.fill("fixture-custom");
    await save();
    await authorize();
    await testRequest(3);
    await url.fill("https://gateway.example:8443/another-path");
    await expect(key).toHaveAttribute("placeholder", /已保存/);
    await url.fill("https://gateway.example/another-path");
    await expect(key).not.toHaveAttribute("placeholder", /已保存/);
    await save();
    assert.equal((await snapshot()).config.hasTextKey, false);
    await provider.selectOption("openai");
    await expect(model).toHaveValue("openai-model");
    await expect(key).toHaveAttribute("placeholder", /已保存/);
    await save();
    await authorize();
    await testRequest(4);
    const state = await snapshot();
    assert.equal(state.config.hasTextKey, true);
    assert.equal(state.config.asrBackend, "local");
    for (const textUrl of [
      "http://gateway.example/chat",
      "https://fixture@gateway.example/chat",
    ]) {
      await assert.rejects(
        call("provider.configure", {
          ...state.config,
          textProvider: "compatible",
          textUrl,
          textKey: "fixture-invalid",
        }),
        /HTTPS/,
      );
    }
    assert.equal((await snapshot()).config.version, state.config.version);
    assert.doesNotMatch(
      JSON.stringify(state),
      /fixture-(openai|anthropic|custom)/,
    );
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    const restored = await snapshot();
    assert.equal(restored.config.textProvider, "openai");
    assert.equal(restored.config.textModel, "openai-model");
    assert.equal(restored.config.hasTextKey, true);
    assert.deepEqual(restored.courses[0].consent, state.courses[0].consent);
    console.log(
      "PASS: provider selection, native endpoints, consent, encrypted key isolation, mocked text tests, restart",
    );
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
