// Native permission checks happen before any recorder, worker or cloud stream exists.
async function ensureMicrophonePermission(systemPreferences, appName) {
  if (process.platform !== "darwin") return;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return;
  if (status === "not-determined") {
    if (await systemPreferences.askForMediaAccess("microphone")) return;
  }
  throw Object.assign(
    new Error(
      `麦克风权限未开启。请在“系统设置 → 隐私与安全性 → 麦克风”中允许 ${appName}，然后重新打开应用。`,
    ),
    { code: "PERMISSION_DENIED" },
  );
}
module.exports = { ensureMicrophonePermission };
