# T05746 证据包 · 气泡体验配置化 + 真实浏览器 UI/性能实测

- 日期：2026-11-15
- 仓库：`D:\code\otherProjects\KarpathyWiki\karpathy-wiki`
- 设计文档：`docs/design/消息气泡交互方案-豆包同款流式体验.md`
- 浏览器：Chrome 157.0.8103.51，CDP `http://127.0.0.1:9222`，窗口 1440×1000
- 前端：Vite dev `http://localhost:5173/wiki/`；API `http://127.0.0.1:3000`
- 测试脚本：`C:\pyfix_tmp\kw-ui-test\ui-test.js`（自动化断言）、`demo-ui.js`（录屏证据）、`scroll-perf.js`（100 条滚动）

## 一、配置化改动

- 新增 `BubbleSettingsPanel.vue` 与 `useBubbleSettings.ts`，并在 `Config.vue` 的「界面主题」内嵌。
- `STORAGE_KEYS` 新增：
  - `BUBBLE_TYPEWRITER='bubbleTypewriter'`，默认 `true`
  - `BUBBLE_SHIMMER='bubbleShimmer'`，默认 `true`
  - `BUBBLE_SHIMMER_SPEED='bubbleShimmerSpeed'`，默认 `1`，范围 `0.5–2.0`
  - `BUBBLE_SHIMMER_FADE_MS='bubbleShimmerFadeMs'`，默认 `600`，范围 `100–2000`
  - `BUBBLE_THINK_EXPANDED='bubbleThinkExpanded'`，默认 `false`
- CSS 流光时长由固定 `1.7s` 改为 `var(--kw-shimmer-duration, 1.7s)`；`AnswerBlock.vue` 的 done 淡出改用 `shimmerFadeMs` prop 并与 `--kw-shimmer-fade-ms` 同源。
- `MessageBubble.vue` 消费全局配置；移除会触发 Vue Boolean casting 的可选 Boolean props，避免未传值时把全局配置覆盖成 false。

## 二、自动化 UI 测试（真实 Vite 页面 + 可控 SSE + CDP Chrome）

权威脚本 `ui-test.js` 最后一次输出 `ok: true`：

- 请求序列 3 条：
  1. 第一问；
  2. `{resume:'ui-run-1'}`（断流后前端自动重连）；
  3. 第二问。
- `initialDuration=1700ms`、`speedDuration=1545ms`、`fadeVar=650ms`（配置写入 CSS 变量生效）。
- `firstSamples=194`、`firstMaxTools=3`：running 流光、思考自动展开、连续工具卡 ≥2。
- `secondSamples=120`、`typewriterMin=0`、`typewriterMax=6`：打字机长度有增长。
- `fadeThink=true`：done 后 `is-fading` 窗口内思考块仍为 `aria-expanded=true`。
- 关闭 `bubbleShimmer` 的真实浏览器验收（`shimmer-off-test.js`）：`ok:true`，`.kw-shimmer=0`、`.kw-caret--fallback=1`，回答继续流式；截图 `14-query-shimmer-off-running.png`。
- 断言通过：running 流光、resume 携带 runId、done 后出现 `is-fading`、最终历史答案带本轮标记。

### 截图说明

| 文件 | 内容 | 备注 |
|---|---|---|
| `00-login-success.png` | 真实登录页登录成功 | 早期截图 |
| `01-config-panel.png` | 配置页气泡设置面板 | 默认值 |
| `02-config-shimmer-off.png` | 关闭「流光扫描」 | 开关生效 |
| `03-config-reload-persist.png` | 刷新后速度/淡出仍生效（1545ms/650ms） | localStorage 持久化 |
| `04-query-running-shimmer.png` | 真实问答页 running 阶段 | 画面停在「深度思考中」，回答区尚未出现 |
| `05-query-fading.png` | 第二问 done 后 | 截图落在淡出结束后的历史消息，未截到淡出瞬间 |
| `06-query-done.png` | 第二问最终历史答案 | 含本轮标记 |
| `07-config-think-expanded.png` | 打开「思考默认展开」 | 配置生效 |
| `08-query-think-expanded-done.png` | 意图截取 done 淡出窗口 | 同 `05`，落在历史消息 |
| `09-query-shimmer-active.png` | **补充证据**：回答正在流式输出，`.kw-shimmer.is-running`、思考展开、3 个工具卡 | 见 `demo-ui.js` |
| `10-query-fading-live.png` | **补充证据**：done 后 `.kw-shimmer.is-fading` 瞬间 | 回答区仍可见、覆盖层淡出 |
| `11-query-fading-180ms.png` | 淡出 180ms 后 | 对照 `10` |
| `12-query-done-live.png` | 淡出完成、气泡卸载后 | 活动轮结束 |
| `13-100-messages-scroll.png` | 100 条历史消息滚动抽查画面 | 侧栏标题「性能抽查 100 条 · T05746」 |
| `14-query-shimmer-off-running.png` | **补充证据**：关闭 `bubbleShimmer` 后 running 态 | `.kw-shimmer` 数量 0，`.kw-caret--fallback` 保留，回答继续流式 |

### 录屏

- `video/T05746-query-ui.mp4`：`demo-ui.js` 通过 CDP `Page.startScreencast` 采集 81 帧（10fps 编码，约 8 秒），覆盖 running 流光、打字机推进、done 后淡出。
- 原始帧目录已删除以节省 D 盘空间；视频为最终证据。

## 三、全量 gate

- API：`pnpm -r gate` → `Test Files 141 passed (141)` / `Tests 1730 passed | 1 skipped (1731)`，耗时 140.20s。
- Frontend 首次全量：1 个失败——`contrast-token-expression.test.ts` 规模锁期望 2729 条颜色 token 消费点，新增 `BubbleSettingsPanel` 带来 11 条后实际 2740。
- 更新基线为 2740（注释记录 T05746 增量）后，frontend gate 全绿：`Test Files 159 passed (159)` / `Tests 1621 passed (1621)`，耗时 1150.76s。
- 结论：两个包 gate 均通过；API 在本轮无代码改动。

## 四、100 条历史消息滚动性能抽查

- 方式：真实 Vite 页面 + IndexedDB 写入 100 条消息（50 问 / 50 答）的真实会话记录 → 打开该会话 → 在 `.chat-body` 内 60 步往返滚动，页面内 rAF 采样帧率 + `PerformanceObserver` longtask。
- 有效结果（`scroll-perf.json`）：
  - 消息数：50 assistant + 50 user = 100
  - 容器 `chat-body`，`scrollHeight=17027`，`clientHeight=793`
  - **60.1 fps**，`frames=203` / `3376ms`
  - **最大帧间隔 18ms**
  - longtask 4 个，最长 **116ms**
  - 判定 `ok: true`
- 说明：首次测量为 1–10 fps，原因是 Chrome 以 `--disable-gpu` 启动且与全量 gate（vitest 满载 CPU）同时运行。Discarded；改用同一 profile 但**不启用 `--disable-gpu`**、gate 结束后复测，得到上述 60.1 fps。该口径才是真实用户 GPU 渲染路径。

## 五、已知产品限制（未在本任务修改）

- 历史消息仍由 `Query.vue` 旧模板 `.msg-bubble` / `ThinkingBlock` / `ThinkFoldPanel` 渲染，不消费新的气泡设置；`MessageBubble` 只渲染 `store.currentTurn` 活动轮。
- done 后 700ms 清空 `currentTurn`，回答落到历史 `store.messages`；因此「思考默认展开 / 打字机 / 流光」只在活动轮可见，历史回看不生效。是否需要迁移历史模板，待单独裁决。
- 断流 resume 的最终答案同样落到旧历史模板，新气泡只覆盖初始活动轮。
