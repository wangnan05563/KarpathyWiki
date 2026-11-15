// localStorage 键名集中管理。
// 为什么需要：键名字符串散落在各组件，易拼写错误且无法统一迁移。
//   集中后修改键名只需改一处，且便于审计哪些数据存了 localStorage。
//
// 约束：apiKey 不存 localStorage（apiKey 唯一权威源为后端 config.json）。
//   本文件仅声明非敏感 UI 状态的键名。

export const STORAGE_KEYS = {
  /** 主题选择（useTheme） */
  THEME: 'karpathy-wiki-theme',
  /** 导航栏折叠状态（App.vue） */
  NAV_COLLAPSED: 'navCollapsed',
  /** 问答侧边栏展开状态（Query.vue） */
  SIDEBAR_STATE: 'sidebarState',
  /** 当前选中的 LLM 预设 key（model store） */
  SELECTED_MODEL_PRESET: 'selectedModelPreset',
  /** 按预设持久化的 baseUrl/model 缓存前缀（Config.vue） */
  LLM_PRESET_CONFIG_PREFIX: 'llmPresetConfig:',
  /** 消息反馈标记前缀（MessageToolbar.vue） */
  MSG_FEEDBACK_PREFIX: 'msg-feedback-',
  /** FloatingChat 面板展开状态持久化（FloatingChat.vue） */
  FLOATING_CHAT_OPEN: 'floatingChatOpen',
  /** FloatingChat FAB 一次性红点引导：首次展开面板后置 true，红点不再出现（FloatingChat.vue，REQ-007/N8） */
  FLOATING_CHAT_GUIDE_SEEN: 'floatingChatGuideSeen',
  /** 认证 token（auth store），仅存非敏感会话 token，用户信息存内存 */
  AUTH_TOKEN: 'authToken',
  /** 多输出模式多选偏好持久化（query store），用户偏好的 thinking/tool_call/answer/multimodal 可见性 */
  OUTPUT_MODES: 'outputModes',
  /** §真流式输出开关持久化（query store），用户偏好是否启用 LLM 逐 token 流式推送 */
  STREAM_MODE: 'streamMode',
  /** 中间件多选偏好持久化（query store），用户启用的 query workflow 功能模块列表 */
  MIDDLEWARES: 'middlewares',
  /** 多模态输出单值模式持久化（Query.vue），思维导图/FAQ/时间线/图像/PPT 选择，跨刷新保留 */
  OUTPUT_MODE: 'outputMode',
  /** 当前选中的 AI 伙伴（skill）持久化（Query.vue），含"文献综述"等预设，跨刷新保留 */
  ACTIVE_SKILL: 'activeSkill',
  /** FR-RM-09 断点续答：上次活跃的会话 id，跨刷新保留，重载后据此自动恢复并续答 */
  LAST_ACTIVE_CONVERSATION: 'lastActiveConversation',
  /** T05743 气泡模式：v2（新气泡）/ legacy（旧渲染），出问题可一键回滚 */
  BUBBLE_MODE: 'bubbleMode',
  /** T05746 气泡打字机开关：关闭后回答一次性全量展示 */
  BUBBLE_TYPEWRITER: 'bubbleTypewriter',
  /** T05746 气泡流光扫描开关：关闭后 running 态不渲染覆盖层，但保留打字光标/骨架 */
  BUBBLE_SHIMMER: 'bubbleShimmer',
  /** T05746 流光速度倍率（0.5~2.0，默认 1.0；CSS 时长 = 1.7s / speed） */
  BUBBLE_SHIMMER_SPEED: 'bubbleShimmerSpeed',
  /** T05746 done 后流光淡出时长（ms，默认 600；需与 --kw-shimmer-fade-ms 同步） */
  BUBBLE_SHIMMER_FADE_MS: 'bubbleShimmerFadeMs',
  /** T05746 done 后思考块默认展开（默认 false；running 期间仍自动展开） */
  BUBBLE_THINK_EXPANDED: 'bubbleThinkExpanded',
} as const;

/** 按预设派生 localStorage 完整键名（如 llmPresetConfig:openai） */
export function presetStorageKey(presetKey: string): string {
  return `${STORAGE_KEYS.LLM_PRESET_CONFIG_PREFIX}${presetKey}`;
}

/** 按消息 id 派生反馈标记键名（如 msg-feedback-abc123） */
export function msgFeedbackKey(messageId: string): string {
  return `${STORAGE_KEYS.MSG_FEEDBACK_PREFIX}${messageId}`;
}
