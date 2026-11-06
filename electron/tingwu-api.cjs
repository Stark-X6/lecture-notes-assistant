const { check, id } = require("./core.cjs");
const HOST = "tingwu.cn-beijing.aliyuncs.com";
function meetingUrl(value) {
  const u = new URL(value);
  check(
    u.protocol === "wss:" &&
      u.hostname === "tingwu-realtime-cn-beijing.aliyuncs.com" &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.pathname === "/api/ws/v1" &&
      u.searchParams.get("mc"),
    "听悟返回了无效的推流地址",
  );
  return u.toString();
}
class TingwuAPI {
  constructor(credentials, sdk) {
    check(
      credentials?.accessKeyId && credentials?.accessKeySecret,
      "请配置听悟 AccessKey ID 和 Secret",
    );
    // Lazy load: existing OpenAI users do not instantiate an Alibaba client.
    const models = sdk || require("@alicloud/tingwu20230930");
    const { Config } = require("@alicloud/openapi-core").$OpenApiUtil;
    const { RuntimeOptions } = require("@darabonba/typescript");
    this.models = models;
    this.runtime = new RuntimeOptions({
      connectTimeout: 10000,
      readTimeout: 10000,
      autoretry: false,
      maxAttempts: 1,
    });
    this.client = new models.default(
      new Config({
        accessKeyId: credentials.accessKeyId,
        accessKeySecret: credentials.accessKeySecret,
        endpoint: HOST,
        regionId: "cn-beijing",
        protocol: "HTTPS",
      }),
    );
  }
  async call(fn) {
    try {
      const response = await fn();
      const body = response.body;
      check(String(body?.code) === "0", "听悟请求未成功");
      return body.data;
    } catch (error) {
      // SDK exceptions can contain signed requests; never forward them to UI/logs.
      const code = String(error.code || "REQUEST_FAILED")
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .slice(0, 80);
      throw new Error(
        `听悟请求失败 (${code})，请检查服务开通、凭据、权限及网络`,
      );
    }
  }
  create(config, taskKey = id()) {
    const m = this.models;
    return this.call(() =>
      this.client.createTaskWithOptions(
        new m.CreateTaskRequest({
          type: "realtime",
          appKey: config.tingwuAppKey,
          input: new m.CreateTaskRequestInput({
            sourceLanguage: config.tingwuLanguage || "cn",
            format: "pcm",
            sampleRate: 16000,
            taskKey,
            progressiveCallbacksEnabled: false,
          }),
          parameters: new m.CreateTaskRequestParameters({
            transcription: new m.CreateTaskRequestParametersTranscription({
              outputLevel: 2,
            }),
            translationEnabled: false,
            autoChaptersEnabled: false,
            meetingAssistanceEnabled: false,
            summarizationEnabled: false,
            textPolishEnabled: false,
          }),
        }),
        {},
        this.runtime,
      ),
    );
  }
  stop(taskId) {
    const m = this.models;
    return this.call(() =>
      this.client.createTaskWithOptions(
        new m.CreateTaskRequest({
          type: "realtime",
          operation: "stop",
          input: new m.CreateTaskRequestInput({ taskId }),
        }),
        {},
        this.runtime,
      ),
    );
  }
  info(taskId) {
    return this.call(() =>
      this.client.getTaskInfoWithOptions(taskId, {}, this.runtime),
    );
  }
}
module.exports = { TingwuAPI, meetingUrl, HOST };
