function writeStalled(now, lastWriteAt, capturedMs, persistedMs) {
  return capturedMs - persistedMs >= 5000 && now - lastWriteAt > 15000;
}
module.exports = { writeStalled };
