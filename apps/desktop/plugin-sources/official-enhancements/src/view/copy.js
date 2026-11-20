export function panelLocale(locale) {
  return /^zh(?:[-_]|$)/i.test(locale ?? "") ? "zh-CN" : "en";
}

const en = {
  title: "Official Enhancements", intro: "Switches apply immediately. Use Save for changes to instruction prompts.",
  on: "On", off: "Off", switchLabel: (title, state) => `${title}: ${state}`,
  instruction: "Instruction prompt", model: "Model", noModels: "No model is enabled yet; add one in Settings.",
  thinking: "Thinking level", noReasoning: "The selected model does not support reasoning.", modelDefault: "Model default",
  levels: { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" },
  saved: "Saved.", promptSaved: (n) => `Saved ${n} ${n === 1 ? "prompt" : "prompts"}.`,
  defaultsLoaded: "Defaults loaded. Click Save to apply.",
  dropped: (keys) => `The running plugin discarded ${keys.join(", ")}. Reload the plugin folder.`,
  reached: ({ modelKey, durationMs, text }) => `Reached ${modelKey} in ${durationMs} ms. Reply: ${text || "(empty)"}.`,
  loadError: (detail) => `Could not load settings: ${detail}`, retry: "Retry", loading: "Loading…",
  staleTitle: "The running plugin is older than this window.",
  staleHint: "Load the updated plugin folder again from Plugins and approve its permissions if prompted. Settings are read-only until then.",
  unsaved: "Unsaved", defaults: "Defaults", defaultsHint: "Load the built-in prompts into the editors", save: "Save", saving: "Saving…",
  saveHint: "Save changes to instruction prompts",
  suggestion: "Next-message suggestion", suggestionDescription: "After an assistant turn, suggest a likely next message. Use Tab to accept or Esc to dismiss.",
  sessionModel: (name) => `Session model (${name})`, appModel: "App default model",
  suggestionHint: (n) => `Uses the session model unless a selected model is available. Up to ${n} suggestions per minute.`,
  suggestionUnsupported: "This version of PI-Desktop does not support Composer suggestions.",
  suggestionFailure: (detail) => `The host refused the last suggestion or conversation read (${detail}). If this is a permission error, reload the plugin folder to confirm access.`,
  suggestionPromptHint: "Sent as the system instruction. The conversation tail is sent as the message.",
  enhancement: "Prompt enhancement", enhancementDescription: "Rewrites a draft on request. The Composer action remains visible when off but does not send a model request.",
  testing: "Testing…", test: "Test model",
  enhancementPromptHint: "Sent as the system instruction. The draft is sent as the message.",
  titles: "Session titles", titlesDescription: "Names a session from its first exchange while it still has a placeholder title.",
  titlesHint: (n) => `Attempts after a completed turn, without overriding a manual title. Up to ${n} titles per minute.`,
  titleLength: "Title length", titleLengthHint: (min, max) => `From ${min} to ${max} characters.`,
  titlePromptHint: "Sent as the system instruction. The first user message, first reply, and character limit are sent as the message.",
  privacy: "Suggestions, prompt enhancement, and session titles send limited inputs to the selected model. Memory stays local until recalled into a conversation.",
  failed: "The request failed.", noModel: "No model is available.", enhancementOff: "Prompt enhancement is off.",
};

const zh = {
  title: "官方增强功能", intro: "开关即时生效。指令提示词的修改需点击「保存」。",
  on: "开启", off: "关闭", switchLabel: (title, state) => `${title}：${state}`,
  instruction: "指令提示词", model: "模型", noModels: "尚未启用模型，请先在设置中添加。",
  thinking: "推理强度", noReasoning: "所选模型不支持推理。", modelDefault: "模型默认",
  levels: { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" },
  saved: "已保存。", promptSaved: (n) => `已保存 ${n} 条提示词。`,
  defaultsLoaded: "已加载默认提示词，点击「保存」后生效。",
  dropped: (keys) => `正在运行的插件未保存这些字段：${keys.join("、")}。请重新加载插件目录。`,
  reached: ({ modelKey, durationMs, text }) => `已连通 ${modelKey}，耗时 ${durationMs} 毫秒。回复：${text || "（空）"}。`,
  loadError: (detail) => `无法加载设置：${detail}`, retry: "重试", loading: "正在加载…",
  staleTitle: "正在运行的插件版本早于此窗口。",
  staleHint: "请在插件页重新加载更新后的插件目录，并在需要时授权。在此之前，设置为只读。",
  unsaved: "未保存", defaults: "恢复默认", defaultsHint: "将内置提示词加载到编辑框", save: "保存", saving: "正在保存…",
  saveHint: "保存指令提示词的修改",
  suggestion: "下一条消息建议", suggestionDescription: "助手完成一轮回复后，提供一条可能的后续消息。按 Tab 接受，按 Esc 关闭。",
  sessionModel: (name) => `会话模型（${name}）`, appModel: "应用默认模型",
  suggestionHint: (n) => `未指定可用模型时使用会话模型。每分钟最多生成 ${n} 条建议。`,
  suggestionUnsupported: "此版本的 PI-Desktop 不支持输入框建议。",
  suggestionFailure: (detail) => `宿主拒绝了上次建议或对话读取（${detail}）。如果是权限问题，请重新加载插件目录并确认授权。`,
  suggestionPromptHint: "作为系统指令发送。近期对话作为消息发送。",
  enhancement: "提示词增强", enhancementDescription: "按需改写草稿。关闭后，输入框中的增强入口仍可见，但不会请求模型。",
  testing: "正在测试…", test: "测试模型",
  enhancementPromptHint: "作为系统指令发送。草稿作为消息发送。",
  titles: "自动会话标题", titlesDescription: "会话仍使用占位标题时，根据首轮对话生成标题。",
  titlesHint: (n) => `回合正常结束后尝试生成，不覆盖手动标题。每分钟最多生成 ${n} 个标题。`,
  titleLength: "标题长度", titleLengthHint: (min, max) => `${min} 至 ${max} 个字符。`,
  titlePromptHint: "作为系统指令发送。首条用户消息、首条回复和字数限制作为消息发送。",
  privacy: "消息建议、提示词增强和自动标题会将有限的输入发送至所选模型。记忆在召回到会话之前保存在本机。",
  failed: "操作失败。", noModel: "没有可用的模型。", enhancementOff: "提示词增强已关闭。",
};

export function panelCopy(locale) {
  return panelLocale(locale) === "zh-CN" ? zh : en;
}

export function panelError(copy, error) {
  if (error?.code === "ENHANCEMENT_NO_MODEL") return copy.noModel;
  if (error?.code === "ENHANCEMENT_DISABLED") return copy.enhancementOff;
  return error?.code ? `${copy.failed} (${error.code})` : copy.failed;
}
