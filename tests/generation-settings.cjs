// Isolated IPC + UI settings regression; never sends a provider request.
const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const data = path.resolve(".test-data", "generation-settings-" + Date.now());
  const launch = () =>
    electron.launch({
      ...(process.env.LECTURE_EXECUTABLE
        ? { executablePath: process.env.LECTURE_EXECUTABLE }
        : {}),
      args: process.env.LECTURE_EXECUTABLE ? [] : ["."],
      env: { ...process.env, LECTURE_DATA_DIR: data },
      timeout: 30000,
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    const settings = await page.evaluate(async () => {
      const { config } = await window.desktop.invoke("snapshot");
      await window.desktop.invoke("provider.configure", {
        ...config,
        mode: "off",
        textUrl: "https://api.deepseek.com/chat/completions",
        textModel: "deepseek-flash",
        maxOutput: 300000,
        textThinking: true,
      });
      return (await window.desktop.invoke("snapshot")).config;
    });
    assert.equal(settings.maxOutput, 300000);
    assert.equal(settings.textThinking, true);
    const bad = await page.evaluate(async (config) => {
      const rejected = [];
      for (const maxOutput of [255, 393217, 300000.5]) {
        try {
          await window.desktop.invoke("provider.configure", {
            ...config,
            maxOutput,
          });
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      try {
        await window.desktop.invoke("provider.configure", {
          ...config,
          textThinking: "yes",
        });
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
      return rejected;
    }, settings);
    assert.deepEqual(bad, [true, true, true, true]);
    await page.getByText("打开示例课程", { exact: false }).click();
    await page.getByRole("button", { name: "API 与设置", exact: true }).click();
    const limit = page.getByLabel("单次最大输出 tokens", { exact: true });
    const thinking = page.getByLabel("启用思考模式（DeepSeek）", {
      exact: true,
    });
    await expect(limit).toHaveValue("300000");
    await expect(thinking).toBeChecked();
    await limit.fill("393216");
    await thinking.uncheck();
    await page
      .getByRole("button", { name: "保存 API 配置", exact: true })
      .click();
    await page
      .getByText("配置已保存。请重新勾选下面的课程授权。", { exact: true })
      .waitFor();
    const after = await page.evaluate(() => window.desktop.invoke("snapshot"));
    assert.equal(after.config.maxOutput, 393216);
    assert.equal(after.config.textThinking, false);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    const restored = await page.evaluate(() =>
      window.desktop.invoke("snapshot"),
    );
    assert.equal(restored.config.maxOutput, 393216);
    assert.equal(restored.config.textThinking, false);
    assert.equal(
      restored.tasks.length,
      0,
      "settings checks must not call a model",
    );
    console.log(
      "PASS: 300000/393216 tokens, thinking toggle, invalid boundaries, UI save and restart persistence",
    );
  } finally {
    await application.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
