// Playwright launches Electron with --use-mock-keychain. Keep fake protocol
// credentials entirely inside the isolated test, without touching the OS vault.
async function fakeCredentialStorage(application) {
  if (process.platform !== "darwin") return;
  await application.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (value) => {
      if (!value.startsWith("fixture-"))
        throw new Error("Unexpected test credential");
      return Buffer.from("test-vault:" + value);
    };
    safeStorage.decryptString = (value) => {
      const encoded = value.toString();
      if (!encoded.startsWith("test-vault:fixture-"))
        throw new Error("Not a test credential");
      return encoded.slice("test-vault:".length);
    };
  });
}
module.exports = { fakeCredentialStorage };
