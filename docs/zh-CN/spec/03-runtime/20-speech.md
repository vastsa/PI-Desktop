# 20. 宿主语音

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/20-speech) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 事实来源：`packages/shared/src/types/speech.ts`、
> `packages/agent-runtime/src/speech/`、
> `apps/desktop/electron/main/services/speech-service.ts`。
> ADR：[0281-host-speech-capability](/adr/0281-host-speech-capability)。

## 1. 能力

独立于聊天流和模型选择器：

```
transcribe({ sessionId, path, mimeType?, language? }) → { text }
synthesize({ sessionId, text, voice?, format? }) → { path, mimeType, dataUrl? }
```

输入是 session scratch 文件路径。输出音频写入该 session 的 scratch。
渲染器不接收 provider 密钥。TTS `dataUrl` 在文件大于8 MiB 时省略。
输入上限25 MiB（`SPEECH_INPUT_TOO_LARGE`）。

## 2. 绑定

`AppSettings.speech` 为可选字段，不升 schema：

```
{
  transcribe?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
  synthesize?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
}
```

协议 id 匹配 `^[a-z][a-z0-9._-]{0,63}$`。speech 为空或缺省即未配置状态；应用界面
不再读取该绑定，调用方只有插件与显式 IPC 调用（ADR 0291）。

## 3. 内置协议

| id | transcribe | synthesize |
|---|---|---|
| `openai_audio` | `POST {baseUrl}/audio/transcriptions` multipart | `POST {baseUrl}/audio/speech` JSON |
| `openai_chat_audio` | 不支持 | `POST {baseUrl}/chat/completions` + `audio:{format,voice}`；读取 `choices.0.message.audio.data` |

本地 OpenAI-Audio 兼容服务器使用 `openai_compatible` provider +
`openai_audio`。推荐模型：OpenAI `whisper-1` / `tts-1`、Groq
`whisper-large-v3`、小米 `mimo-v2.5-tts`。

## 4. IPC

```
pi-desktop/speech/getStatus → SpeechStatus（无密钥）
pi-desktop/speech/transcribe
pi-desktop/speech/synthesize
```

错误码：`SPEECH_NOT_CONFIGURED`、`SPEECH_PROTOCOL_UNSUPPORTED`、
`SPEECH_INPUT_TOO_LARGE`。网络/认证复用 `NETWORK_ERROR` /
`PROVIDER_UNAUTHORIZED`。provider 缺失或禁用返回 `NOT_FOUND`。

## 5. 插件适配器

`pi.speech.registerAdapter({ protocol, label, roles, handle })` 需要
`speech.adapter.register`（高风险）。handle 留在插件进程内。
宿主仅存元数据并调用 `speech.handle`。handle 可返回
`{ kind: "text" }`、`{ kind: "audio", mimeType, data }` 或
`{ kind: "http", call }` 由宿主用绑定密钥代发。HTTP URL
必须保持在 provider origin。内置协议 id 受保留。卸载时注销。

## 6. 产品

设置页面**不再提供**语音入口（ADR 0291）。绑定由调用方通过宿主设置接口写入，
消费方只有插件与 `speech/*` IPC，渲染器没有任何转写或朗读控件。
Whisper / TTS 模型不得出现在聊天模型选择器中。

v1 不实现麦克风采集、Realtime 和 agent 工具。
