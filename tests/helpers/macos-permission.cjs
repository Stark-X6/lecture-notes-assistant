// Chromium fake audio does not bypass macOS TCC; fixture only the OS boundary.
async function fakeMicrophonePermission(application) {
  if (process.platform !== "darwin") return;
  await application.evaluate(({ systemPreferences }) => {
    systemPreferences.getMediaAccessStatus = () => "granted";
  });
}
module.exports = { fakeMicrophonePermission };
