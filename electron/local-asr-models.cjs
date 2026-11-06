const SENSE_ID = "WEAAEW/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const sample = {
  name: "test_wavs/zh.wav",
  repo: SENSE_ID,
  size: 178988,
  sha: "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373",
};
const MODELS = {
  sensevoice: {
    id: "sensevoice",
    name: "SenseVoiceSmall INT8",
    dir: "sensevoice-small-int8",
    repo: SENSE_ID,
    files: [
      {
        name: "model.int8.onnx",
        size: 239233841,
        sha: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
      },
      {
        name: "tokens.txt",
        size: 315894,
        sha: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
      },
      {
        name: "LICENSE",
        size: 71,
        sha: "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17",
      },
      sample,
    ],
  },
  qwen3: {
    id: "qwen3",
    name: "Qwen3-ASR 0.6B INT8",
    dir: "qwen3-asr-0.6b-int8",
    repo: "zengshuishui/Qwen3-ASR-onnx",
    files: [
      {
        name: "README.md",
        size: 529,
        sha: "7c0bc48a7b0ede90685fdd507e88275a5c7c7f82ae7f8754adac6f9effccd5e1",
      },
      {
        name: "model_0.6B/conv_frontend.onnx",
        size: 44148281,
        sha: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
      },
      {
        name: "model_0.6B/decoder.int8.onnx",
        size: 755914231,
        sha: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
      },
      {
        name: "model_0.6B/encoder.int8.onnx",
        size: 182491662,
        sha: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
      },
      {
        name: "tokenizer/merges.txt",
        size: 1671853,
        sha: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
      },
      {
        name: "tokenizer/tokenizer_config.json",
        size: 12487,
        sha: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
      },
      {
        name: "tokenizer/vocab.json",
        size: 2776833,
        sha: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
      },
      sample,
    ],
  },
};
for (const m of Object.values(MODELS))
  m.modelPage = `https://modelscope.cn/models/${m.repo}`;
module.exports = { MODELS };
