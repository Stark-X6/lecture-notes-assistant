const { LocalASR } = require('../electron/local-asr.cjs');
const path = require('node:path');
(async () => {
  let last = -1;
  const asr = new LocalASR({ modelDir: path.resolve('..', '.qa', 'sensevoice-small-int8'), onChange: () => {
    const s = asr.status();
    if (Math.floor(s.progress / 10) !== last) { last = Math.floor(s.progress / 10); console.log(s.state, s.progress); }
  }});
  try {
    await asr.install();
    const result = await asr.test();
    console.log(JSON.stringify(result));
    if (!/开放时间|开饭时间/.test(result.text)) throw new Error('中文参考音频识别未得到预期内容');
  } finally { asr.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
