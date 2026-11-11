import { API_BASE, apiFetch } from '../utils/apiBase';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { consumeSSE } from '../utils/sse';
import { saveBatchSnapshot, loadBatchSnapshot } from '../utils/compile-batch-snapshot';
import type {
  CompileStep,
  DoneData,
  IngestPayload,
  ProgressData,
  TimelineItem,
  RunSummary,
  RunLogEntry,
  BatchFileGroup,
  DraftBatchItem
} from '../types';

// §优化方案3：编译状态持久化 localStorage key
// 为什么单独抽常量：便于统一管理与未来重命名，避免散落字符串字面量
const COMPILE_STATE_STORAGE_KEY = 'wiki:compile:state';

// 草稿批量发布状态持久化 key
// 为什么独立 key：与编译状态分离，避免互相覆盖；草稿发布是 Browse.vue 业务
// 切换页面又切回后从 localStorage 恢复进度信息
const DRAFT_PUBLISH_STATE_STORAGE_KEY = 'wiki:draft:publish:state';

// §优化方案3：可持久化的状态子集
// 为什么不用全部 store 字段：pendingPayload 可能含 FormData 不可序列化，需独立处理
interface PersistableCompileState {
  timeline: TimelineItem[];
  isCompiling: boolean;
  isDone: boolean;
  isCancelled: boolean;
  errorMessage: string;
  doneMessage: string;
  currentRunId: string;
  stageTimings: Record<string, number>;
  compileStartedAt: number;
  // 单文件模式才需要持久化 payload 元信息（FormData 不可直接序列化，只存类型标识）
  pendingPayloadType: 'url' | 'text' | null;
  pendingPayloadContent: string | null;
  // T04550：服务端作业标识与已收事件序号，刷新后凭二者续订补齐丢失帧
  jobId: string;
  lastSeq: number;
}

// 草稿发布可持久化状态子集
// 为什么不含 AbortController：AbortController 是运行时句柄，不可序列化；只持久化 UI 可见状态
interface PersistableDraftPublishState {
  batchItems: DraftBatchItem[];
  isPublishing: boolean;
  progressMessage: string;
}

// 步骤展示名映射：后端用英文 step 标识，前端需要友好中文。
// 单一来源（PRD P4）：Progress.vue / SingleFileProgressBar 均改调 store.stepLabel，
// 不再各自维护私有副本，消除「7 步 / 5 步 / 硬编码 8」三套不一致导致「进度 100% 但阶段名没走完」。
// T02784：帮助文档 progress 章节同样从这里取阶段实名，不再抄第二份
export const STEP_LABEL: Record<string, string> = {
  archive: '存档原始资料',
  read_schema: '读取结构规范',
  extract: '抽取要点',
  generate_page: '生成页面',
  update_index: '更新索引',
  update_log: '记录日志',
  // T03613：这一阶段原先只有 running 聚合行、没有中文标签，界面直接裸显 "generate_tags"
  generate_tags: '生成 AI 标签建议',
  finalize: '收尾'
};

// 从 ProgressData.data 提取 page 信息：path 必须存在；title 缺失时回退到 path 的 basename。
// 为什么允许 title 缺失：后端 generate_page 事件目前只带 path 不带 title，若严格要求 title
//   会导致「实际已生成页面但计数为 0」。回退 basename 既保证计数正确，又不破坏既有带 title 路径。
// 为什么入参类型只取 path/title：调用方传入的可能是 ProgressData 与批量扩展的交叉类型，
//   TS 对交叉类型的字段 narrow 不够智能，会导致返回类型推断失败。只取需要的字段更稳健。
function extractPage(data: { path?: string; title?: string } | undefined): { path: string; title: string } | undefined {
  if (!data?.path) return undefined;
  const title = data.title || data.path.split('/').pop() || data.path;
  return { path: data.path, title };
}

export const useCompileStore = defineStore('compile', () => {
  // SSE 推送的时间线项
  const timeline = ref<TimelineItem[]>([]);
  // 当前正在运行的步骤，用于驱动机器人动画
  const currentStep = ref<CompileStep | null>(null);
  const isCompiling = ref(false);
  const isDone = ref(false);
  const errorMessage = ref<string>('');
  const result = ref<DoneData | null>(null);
  // §11.2 done 事件的 message，用于展示"编译完成"或"缓存命中"等提示
  const doneMessage = ref<string>('');
  // 保存本次投递的载荷，进度页需要据此发起请求
  const pendingPayload = ref<IngestPayload | null>(null);
  // §11.2 历史编译任务列表（空状态时展示）
  const runs = ref<RunSummary[]>([]);
  const loadingRuns = ref(false);
  // T02458（PRD P1/X6，P0）：区分「加载中 / 加载失败 / 真空白」三态。
  // 旧实现 catch 里 runs.value=[] 把「接口失败」伪装成「无历史」，导致 Progress 重挂载
  // 重新 loadRuns 返空时把 Dashboard 已加载的数据清空，用户看到「历史丢了」的矛盾。
  const runsError = ref<string | null>(null);
  // 是否已成功加载过一次：用于区分「加载中」与「已确认空」（不依赖 runs.length，因为失败也空）
  const runsLoaded = ref(false);
  // 最近一次成功加载的时间戳：页脚标注「数据截至 HH:mm」（PRD X6 跨视图一致性）
  const runsUpdatedAt = ref<string | null>(null);
  // §12.3-8 日志查看
  const logEntries = ref<RunLogEntry[]>([]);
  const loadingLog = ref(false);
  // 批量编译模式：true 时 Progress.vue 调用 /api/compile/batch
  const isBatchMode = ref(false);
  // 批量编译的待发 FormData（与单文件 pendingPayload 分离，避免类型混淆）
  const pendingBatchPayload = ref<FormData | null>(null);
  // 本次提交的文件数：在 prepareBatchCompile 时从 FormData 数一次存下来。
  // 为什么不在组件里现数：Pinia 会把 ref 里的对象包成响应式代理，FormData 走代理后
  // 内部私有字段不可读（happy-dom 下直接抛错），组件侧只读这个标量最稳。
  // T03438：batch_start 到达前用它显示「正在上传并解析 N 个文件」。
  const pendingBatchFileCount = ref(0);
  // 批量编译的文件分组：按 fileIndex 路由 SSE 事件
  const batchGroups = ref<BatchFileGroup[]>([]);
  // 批量编译的拒绝列表（来自 batch_start 事件）
  const batchRejected = ref<Array<{ name: string; reason: string }>>([]);
  // 用户主动取消标识：与 errorMessage 区分，让进度条组件能识别"取消态"而非"错误态"
  // 为什么独立字段：errorMessage 用于后端推送的错误事件，cancelCompile 是用户主动行为，
  //   两者视觉提示不同（取消是中性粉色，错误是红色），且文案语义不同
  const isCancelled = ref(false);
  // T03591 幂等命中：服务端未新建任务、只回放了进行中任务的进度。
  // 与错误区分开——重复提交不是失败，不应显示红色失败态。
  const dedupeMessage = ref('');
  // T03591 重试：正在重试的分组下标（用于禁用按钮，避免同组并发重试）
  const retryingIndexes = ref<number[]>([]);
  // 单文件模式最近一次失败是否可重试（后端 done/error 事件携带 retryable）
  const lastErrorRetryable = ref(false);
  // T03591：重试流的取消句柄。与主编译流分开持有——用户切走页面时两者都要中止
  let retryAbortController: AbortController | null = null;

  // ===== T04508：编译 SSE 流由 store 持有 =====
  // 为什么从 Progress.vue 提到这里：App.vue 用 v-if 切换视图，切走即卸载组件，
  //   旧实现在 onBeforeUnmount 里 abort() 这条 fetch 流——后端把「客户端断连」当成
  //   「取消编译」直接中断任务（routes/compile.ts 的 isAborted() break），于是切回来
  //   只剩 localStorage 快照，只能标成「已中断」。流一旦归 store 持有，卸载组件不
  //   abort，浏览器侧这条请求就还活着：编译继续跑、事件继续写进下面的响应式字段，
  //   切回来看到的是实时进度而不是残影。同一手法见 draftAbortController。
  // 为什么非响应式：AbortController 是运行时句柄，放 ref 内会被 Pinia 深度代理
  let streamAbortController: AbortController | null = null;
  // 是否有一条在途的编译/续传流：Progress.vue 据此决定「原地续显」而不是重发请求
  const streamActive = ref(false);
  // T04508：批量快照的「已中断」标识。放 store 而非组件局部：整页刷新后重新进入
  //   进度页时它要和恢复出来的分组一起存活，组件卸载再挂载不该把它丢掉。
  const batchInterrupted = ref(false);

  // ===== 草稿批量发布状态（Browse.vue 业务）=====
  // 为什么放在 store 而非 Browse.vue 局部 ref：App.vue 用 v-if 切换视图，
  //   切走时 Browse.vue 会被卸载，导致 batchItems/compiling/progressMessage 全部丢失
  //   切回后用户看不到已经进行中的进度信息。提升到 store 后跨组件生命周期保留
  // SSE 流是浏览器全局任务，组件被 v-if 卸载时不会自动 abort；handler 闭包仍能
  //   持续修改这些 store 字段，所以切回时用户能看到完整的进度面板
  const draftBatchItems = ref<DraftBatchItem[]>([]);
  const draftIsPublishing = ref(false);
  const draftProgressMessage = ref<string>('');
  // AbortController 放在 store 非响应式字段（plain）中
  // 为什么非响应式：AbortController 是运行时句柄，不触发 UI 更新；放 ref 内会被 Pinia 深度代理
  // 为什么放 store：Browse.vue 卸载后仍能调用 abort() 取消后台 SSE 任务
  let draftAbortController: AbortController | null = null;

  // §优化方案2：各阶段耗时统计（ms）
  // 为什么用 Record 而非 Map：响应式追踪更稳定，且 JSON.stringify 友好便于持久化
  const stageTimings = ref<Record<string, number>>({});
  // 当前阶段开始时间戳（ms），step 变化时累计上一阶段耗时并重置
  const currentStepStartedAt = ref<number>(0);
  // §优化方案1：编译整体开始时间戳，用于展示总耗时
  const compileStartedAt = ref<number>(0);

  // §优化方案3：当前编译运行的 runId，用于切回页面时调用 /api/compile/resume/:runId
  // 为什么独立字段：后端 SSE 事件 ProgressEvent 不带 runId，需要从 runs 列表反向查找
  //   或在 onMounted 时通过 GET /api/compile/runs 查找 status=running 的最新任务
  const currentRunId = ref<string>('');

  // ===== T04550：服务端编译作业 =====
  // 编译已改为服务端 job：断连不取消，刷新后凭 jobId 查状态 + 按 lastSeq 续订事件。
  // 为什么与 currentRunId 并存：runId 是编译历史（可 resume 失败 run），jobId 是本次执行的生命周期。
  const currentJobId = ref<string>('');
  // 已收到的最大事件序号；服务端从 lastSeq + 1 开始回放
  const lastStreamSeq = ref(0);

  // §优化方案1：单文件编译模式的步骤总数估算
  // 为什么需要估算：harness 是 LLM 驱动的循环，步骤数动态，无固定上限
  //   估算策略：基于历史日志（如 SHCPE 7 步）+ 4 个核心阶段（archive/read_schema/extract/generate_page）
  // P4（PRD）：估算总阶段数 = STEP_LABEL 键数（单一来源），消除硬编码 8 与标签数不一致
  const ESTIMATED_TOTAL_STEPS = Object.keys(STEP_LABEL).length;

  // §优化方案1：已完成步骤数（基于 timeline 去重统计）
  // 为什么用 set 而非 timeline.length：单步可能推送多条事件（如多次 read_file），
  //   按去重的 step 名统计更接近"阶段数"
  const completedStepCount = computed(() => {
    const steps = new Set<string>();
    for (const item of timeline.value) {
      // running 态不算完成，done 才算
      if (item.status === 'done') {
        steps.add(item.step);
      }
    }
    return steps.size;
  });

  // §优化方案1：当前进度百分比（0-100）
  // 为什么用 Math.min 防止超 100：实际步骤可能超过估算值，进度条溢出视觉异常
  const progressPercentage = computed(() => {
    if (!isCompiling.value && !isDone.value) return 0;
    // §done 态强制 100%：实际阶段数可能少于 ESTIMATED_TOTAL_STEPS（如缓存命中跳过部分阶段），
    //   但对用户而言"已完成"就是 100%，避免显示 63% 等令人困惑的数字
    if (isDone.value) return 100;
    return Math.min(100, Math.round((completedStepCount.value / ESTIMATED_TOTAL_STEPS) * 100));
  });

  // §优化方案2：总耗时（ms），编译中实时累加，完成后固定
  // 为什么用 computed 而非 ref：派生自 compileStartedAt + 当前时间，避免手动维护
  const totalElapsedMs = computed(() => {
    if (compileStartedAt.value === 0) return 0;
    if (!isCompiling.value) {
      // 完成或出错时，取最后一个 timeline 项的时间戳作为结束时间
      const lastTs = timeline.value.length > 0
        ? timeline.value[timeline.value.length - 1].timestamp
        : compileStartedAt.value;
      return lastTs - compileStartedAt.value;
    }
    return Date.now() - compileStartedAt.value;
  });

  // 步骤中文名（PRD P4 统一出口：所有视图经此取中文标签）
  const stepLabel = computed(() => (s: string | null) =>
    s ? STEP_LABEL[s] ?? s : ''
  );

  // 已生成页面数（来自 generate_page 事件）
  // 批量模式下事件进 batchGroups[*].timeline 而非全局 timeline，必须聚合分组；
  // 同一页面可能在多个步骤被重复写入，用 Map 按 path 去重，保证「共生成 X 个页面」是页面数而非事件数。
  const generatedPages = computed(() => {
    const pages = new Map<string, { path: string; title: string }>();
    const collect = (t: TimelineItem) => {
      if (t.step === 'generate_page' && t.page && !pages.has(t.page.path)) {
        pages.set(t.page.path, t.page);
      }
    };
    if (isBatchMode.value) {
      for (const g of batchGroups.value) {
        g.timeline.forEach(collect);
      }
    } else {
      timeline.value.forEach(collect);
    }
    return Array.from(pages.values());
  });

  // 重置状态，用于"再投一篇"
  function reset() {
    timeline.value = [];
    currentStep.value = null;
    isCompiling.value = false;
    isDone.value = false;
    errorMessage.value = '';
    result.value = null;
    doneMessage.value = '';
    pendingPayload.value = null;
    isBatchMode.value = false;
    pendingBatchPayload.value = null;
    pendingBatchFileCount.value = 0;
    batchGroups.value = [];
    batchRejected.value = [];
    isCancelled.value = false;
    dedupeMessage.value = '';
    retryingIndexes.value = [];
    lastErrorRetryable.value = false;
    // §优化方案2/3：同步清空新增字段
    stageTimings.value = {};
    currentStepStartedAt.value = 0;
    compileStartedAt.value = 0;
    currentRunId.value = '';
    currentJobId.value = '';
    lastStreamSeq.value = 0;
    // T04508：新一轮投递/重置必须收掉上一在途流，否则两条流同时往同一批字段写事件
    stopStream();
    batchInterrupted.value = false;
    // 重置时同步清除持久化状态，避免切回时误恢复已主动重置的编译
    clearPersistedState();
  }

  // ===== 草稿发布方法集 =====
  // 启动草稿批量发布：初始化 batchItems 列表 + publishing 状态
  // 为什么 items 列表创建用 drafts.value.map(d => ({...}))：拷贝时只保留必要字段，
  //   避免直接引用导致外部修改穿透到 store
  function startDraftPublish(items: DraftBatchItem[]): void {
    draftBatchItems.value = items.map((d) => ({ ...d }));
    draftIsPublishing.value = true;
    draftProgressMessage.value = '开始批量编译…';
    persistDraftPublishState();
  }

  // 启动单条草稿发布：单 draft 模式，items 列表只有一项
  function startSingleDraftPublish(item: DraftBatchItem): void {
    draftBatchItems.value = [{ ...item }];
    draftIsPublishing.value = true;
    draftProgressMessage.value = '准备编译…';
    persistDraftPublishState();
  }

  // 更新某条草稿的状态/消息/页面
  // 为什么返回新对象：Vue ref 数组项变更需要重新赋值才能触发响应式
  //   数组项本身是 ref 元素，直接修改 .status 是非响应式的（对象整体 ref 才追踪）
  function updateDraftItem(index: number, patch: Partial<DraftBatchItem>): void {
    const item = draftBatchItems.value[index];
    if (!item) return;
    draftBatchItems.value[index] = { ...item, ...patch };
    persistDraftPublishState();
  }

  // 追加某条草稿生成的页面
  // 为什么用 index 定位：SSE 事件携带 fileIndex，与 batchItems 数组下标对齐
  function appendDraftItemPage(index: number, page: { path: string; title: string }): void {
    const item = draftBatchItems.value[index];
    if (!item) return;
    draftBatchItems.value[index] = {
      ...item,
      pages: [...item.pages, page],
    };
    persistDraftPublishState();
  }

  // 设置顶部进度文本
  function setDraftProgress(message: string): void {
    draftProgressMessage.value = message;
    persistDraftPublishState();
  }

  // 设置 AbortController：Browse.vue 启动 SSE 时调用，让 store 持有取消句柄
  function setDraftAbortController(controller: AbortController | null): void {
    draftAbortController = controller;
  }

  // 取消草稿发布：调用 AbortController 终止 SSE
  // 与 abortCompile 的区别：本函数专用于草稿发布，区分 publish / compile 两种业务
  function abortDraftPublish(): void {
    if (draftAbortController) {
      draftAbortController.abort();
      draftAbortController = null;
    }
    draftIsPublishing.value = false;
    if (draftProgressMessage.value !== '已取消') {
      draftProgressMessage.value = '已取消';
    }
    persistDraftPublishState();
  }

  // 标记草稿发布完成（成功/失败后调用，保留 items 列表供查看）
  function finalizeDraftPublish(): void {
    draftIsPublishing.value = false;
    persistDraftPublishState();
  }

  // 主动清空草稿发布面板（用户点击关闭按钮）
  function clearDraftPublish(): void {
    if (draftAbortController) {
      draftAbortController.abort();
      draftAbortController = null;
    }
    draftBatchItems.value = [];
    draftIsPublishing.value = false;
    draftProgressMessage.value = '';
    clearDraftPublishPersistedState();
  }

  // 草稿发布状态持久化：与编译持久化分离，互不影响
  // 为什么用 localStorage 而非 IndexedDB：状态体量小（几十到几百条记录），
  //   localStorage 同步 API 简单可靠；IndexedDB 异步 API 复杂度更高但收益不大
  function persistDraftPublishState(): void {
    try {
      const state: PersistableDraftPublishState = {
        batchItems: draftBatchItems.value,
        isPublishing: draftIsPublishing.value,
        progressMessage: draftProgressMessage.value,
      };
      localStorage.setItem(DRAFT_PUBLISH_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage 满或禁用时静默失败
    }
  }

  // 从 localStorage 恢复草稿发布状态
  // 为什么要恢复：用户刷新页面或长时间切走后，store 内存状态会丢失
  //   恢复后切回 Browse.vue 能继续看到之前的工作
  function loadDraftPublishState(): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_PUBLISH_STATE_STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw) as PersistableDraftPublishState;
      if (!Array.isArray(state.batchItems) || state.batchItems.length === 0) {
        return false;
      }
      draftBatchItems.value = state.batchItems;
      // 切回时强制为 false：避免误判为"正在发布"导致 UI 一直显示加载动画
      // 后端 SSE 流已经在独立 task 中运行，无法再关联；正确做法是显示当前快照
      draftIsPublishing.value = false;
      draftProgressMessage.value = state.progressMessage ?? '';
      return true;
    } catch {
      return false;
    }
  }



  // §优化方案2：开始新阶段——记录开始时间，累计上一阶段耗时
  // 为什么在 step 变化时调用：检测到 step 切换意味着上一阶段已结束
  function startStage(step: string): void {
    const now = Date.now();
    if (currentStepStartedAt.value > 0 && currentStep.value) {
      // 累计上一阶段耗时：同一 step 可能多次推送事件，时间累加
      const prevStep = currentStep.value as string;
      const elapsed = now - currentStepStartedAt.value;
      stageTimings.value = {
        ...stageTimings.value,
        [prevStep]: (stageTimings.value[prevStep] ?? 0) + elapsed,
      };
    }
    currentStep.value = step as CompileStep;
    currentStepStartedAt.value = now;
    // §优化方案1：首次进入编译态时记录整体开始时间
    if (compileStartedAt.value === 0) {
      compileStartedAt.value = now;
    }
  }

  // §优化方案2：完成所有阶段——done 事件触发时累计最后一阶段耗时
  function finishAllStages(): void {
    if (currentStepStartedAt.value > 0 && currentStep.value) {
      const lastStep = currentStep.value as string;
      const elapsed = Date.now() - currentStepStartedAt.value;
      stageTimings.value = {
        ...stageTimings.value,
        [lastStep]: (stageTimings.value[lastStep] ?? 0) + elapsed,
      };
    }
    currentStepStartedAt.value = 0;
    currentStep.value = null;
  }

  // §优化方案3：持久化当前编译状态到 localStorage
  // 为什么需要：用户切换页面时 SSE 流会断开，切回时需重建上下文（timeline/进度/耗时）
  //   配合后端 /api/compile/resume/:runId 可恢复未完成的编译
  function persistState(): void {
    if (isBatchMode.value) return; // 批量模式 FormData 不可序列化，跳过
    const payloadType = pendingPayload.value && !(pendingPayload.value instanceof FormData)
      ? (pendingPayload.value as { type: 'url' | 'text'; content: string }).type
      : null;
    const payloadContent = pendingPayload.value && !(pendingPayload.value instanceof FormData)
      ? (pendingPayload.value as { type: 'url' | 'text'; content: string }).content
      : null;
    const state: PersistableCompileState = {
      timeline: timeline.value,
      isCompiling: isCompiling.value,
      isDone: isDone.value,
      isCancelled: isCancelled.value,
      errorMessage: errorMessage.value,
      doneMessage: doneMessage.value,
      currentRunId: currentRunId.value,
      stageTimings: stageTimings.value,
      compileStartedAt: compileStartedAt.value,
      pendingPayloadType: payloadType,
      pendingPayloadContent: payloadContent,
      jobId: currentJobId.value,
      lastSeq: lastStreamSeq.value,
    };
    try {
      localStorage.setItem(COMPILE_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage 满或禁用时静默失败，不阻断主流程
    }
  }

  // §优化方案3：从 localStorage 恢复编译状态
  // 返回值表示是否恢复了"进行中"的编译（调用方据此决定是否触发 resume）
  function loadPersistedState(): boolean {
    try {
      const raw = localStorage.getItem(COMPILE_STATE_STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw) as PersistableCompileState;
      // 仅恢复有意义的状态：进行中/已完成/已取消/出错，空状态不恢复
      if (!state.isCompiling && !state.isDone && !state.isCancelled && !state.errorMessage) {
        return false;
      }
      // T03613 兜底：恢复出来的行若仍是 running，说明那条 SSE 早就断了、终态事件不会再来。
      // 继续转圈就是用户看到的「假死在运行中」；也不能报「失败」——任务可能仍在服务端跑完。
      // 故降级为「已中断」：状态可读、不谎报结果。
      timeline.value = (state.timeline ?? []).map((t) =>
        t.status === 'running' ? { ...t, status: 'interrupted' as const } : t,
      );
      isCompiling.value = false; // 切回时强制设为 false，避免误触发 startCompile
      isDone.value = state.isDone ?? false;
      isCancelled.value = state.isCancelled ?? false;
      errorMessage.value = state.errorMessage ?? '';
      doneMessage.value = state.doneMessage ?? '';
      currentRunId.value = state.currentRunId ?? '';
      stageTimings.value = state.stageTimings ?? {};
      compileStartedAt.value = state.compileStartedAt ?? 0;
      currentJobId.value = state.jobId ?? '';
      lastStreamSeq.value = state.lastSeq ?? 0;
      // 恢复 pendingPayload（仅 url/text 类型，FormData 不可恢复）
      if (state.pendingPayloadType && state.pendingPayloadContent) {
        pendingPayload.value = {
          type: state.pendingPayloadType,
          content: state.pendingPayloadContent,
        };
      }
      // 返回是否需要恢复：仅"切走时正在编译"的场景需要 resume
      return state.isCompiling === true && !state.isDone && !state.isCancelled;
    } catch {
      return false;
    }
  }



  // §优化方案3：设置当前 runId（从 runs 列表查询后填充）
  function setCurrentRunId(runId: string): void {
    currentRunId.value = runId;
  }

  // 中止当前编译：仅复位 isCompiling，保留 pendingPayload/isDone/errorMessage
  // 为什么需要：编译流被中止（AbortError）时调用，让 store 状态与实际编译流保持一致。
  //   否则 prepareCompile 设置的 isCompiling=true 会在流已结束后持续为 true，
  //   进度条卡死在转圈
  // T04508：切页不再走这里——流归 store 持有后卸载组件不会中止请求，也就不需要复位状态
  function abortCompile() {
    if (isCompiling.value) {
      isCompiling.value = false;
    }
    retryAbortController?.abort();
  }

  // 用户主动取消编译：标记 isCancelled 让进度条组件切换到"取消态"视觉
  // 与 abortCompile 的区别：abortCompile 是流被中止后的隐式复位，不设置取消标识；
  //   cancelCompile 是用户显式点击"取消编译"按钮，需要在 UI 上展示取消态
  // 为什么不复位 batchGroups：保留已完成进度供用户查看（"已完成 3/10"）
  // T04508：取消要真的断掉在途流（组件已不再持有句柄），先落取消态再 stopStream，
  //   让被中止那一侧的 catch 走「自己不是当前流」分支，不会覆盖掉刚写的取消态
  function cancelCompile() {
    isCancelled.value = true;
    isCompiling.value = false;
    // T04550：取消是显式动作——先让服务端停作业，再断本端流。
    // 旧口径靠 abort 连接让后端把断连当取消；现在断连只退订，作业会继续跑。
    const jobId = currentJobId.value;
    if (jobId) {
      void apiFetch(`${API_BASE}/compile/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {
        // 取消失败（作业已终态/过期）不影响本地取消态，前端不再继续渲染进度
      });
    }
    stopStream();
    persistProgress();
  }

  // 编译流在「未收到终止事件」的情况下结束：代理空闲断流、网络中断、服务端重启
  // （停服时后端先补 server-shutdown 再 end）都会走到这里。
  // 旧实现只把 isCompiling 留在 true，进度页停在「正在编译 X/Y」甚至「0/0」，
  // 既没有错误提示也没有重试入口——用户看到的就是「编译卡住不动」。
  // 收敛在 store：Progress.vue 的首连与 resume 两个消费点都调用，避免两处各写一套判定。
  function handleStreamEnd(reason?: string): void {
    if (!isCompiling.value) return;
    isCompiling.value = false;
    errorMessage.value = reason
      || '编译连接已断开（服务可能重启或网络中断），已完成部分不受影响，可返回投递页重试';
    finishAllStages();
    clearPersistedState();
  }

  // 投递前预存载荷并进入编译态
  function prepareCompile(payload: IngestPayload) {
    reset();
    pendingPayload.value = payload;
    isCompiling.value = true;
    // §优化方案1：记录编译开始时间，便于总耗时展示
    compileStartedAt.value = Date.now();
  }

  // T03591 单文件重试：复用已保存的 pendingPayload 重新提交（不 reset，保留上一轮时间线可追溯）。
  // 为什么在 store 而不在 Progress.vue：错误态/时间线/状态复位都要动，放一起避免组件里散落赋值。
  function beginRetrySingle(): boolean {
    if (!pendingPayload.value || isCompiling.value) return false;
    errorMessage.value = '';
    isDone.value = false;
    dedupeMessage.value = '';
    lastErrorRetryable.value = false;
    isCompiling.value = true;
    if (compileStartedAt.value === 0) compileStartedAt.value = Date.now();
    timeline.value.push({
      step: 'archive',
      status: 'running',
      message: '重试：使用上次的投递内容重新编译',
      timestamp: Date.now(),
    });
    return true;
  }

  // T03591 批量重试后重算整体结果：只在所有分组都落定（无 pending/running）时收口，
  // 避免「一个文件重试成功就把整批标成完成」。
  function refreshBatchOutcome(): void {
    const groups = batchGroups.value;
    if (groups.length === 0) return;
    if (groups.some((g) => g.status === 'pending' || g.status === 'running')) {
      isCompiling.value = true;
      return;
    }
    const failed = groups.filter((g) => g.status === 'error').length;
    isCompiling.value = false;
    isDone.value = failed === 0;
    errorMessage.value = failed > 0
      ? `批量编译完成，仍有 ${failed} 个文件失败，可点击对应文件的重试`
      : '';
    if (failed === 0) {
      doneMessage.value = `批量编译完成，共处理 ${groups.length} 个文件`;
    }
  }

  // T03591 批量分组重试：用失败事件回带的 rawPath 从存档重新编译，不要求用户重新上传。
  // 事件由服务端注入 fileIndex，复用既有 file_done/file_error 处理，分组状态自然流转。
  async function retryFileGroup(fileIndex: number): Promise<void> {
    const group = batchGroups.value[fileIndex];
    if (!group?.rawPath || !group?.retryable) return;
    if (retryingIndexes.value.includes(fileIndex)) return;
    retryingIndexes.value = [...retryingIndexes.value, fileIndex];
    group.attempts = (group.attempts ?? 0) + 1;
    group.timeline.push({
      step: 'archive',
      status: 'running',
      message: `第 ${group.attempts} 次重试：从存档 ${group.rawPath} 重新编译`,
      timestamp: Date.now(),
    });
    group.status = 'running';
    group.errorMessage = '';
    isCompiling.value = true;
    isDone.value = false;
    errorMessage.value = '';
    dedupeMessage.value = '';
    retryAbortController = new AbortController();
    // 幂等命中（服务端已有同一 rawPath 的重试在跑）：本组收不到后续进度，
    // 不能停在 running，也不能误报「连接断开」。
    let deduped = false;
    try {
      const res = await apiFetch(`${API_BASE}/compile/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawPath: group.rawPath,
          fileName: group.fileName,
          fileIndex,
          fileCount: batchGroups.value.length,
        }),
        signal: retryAbortController.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await consumeSSE(res, (eventType, parsed) => {
        if (eventType === 'deduped' || eventType === 'batch_deduped') deduped = true;
        // T05554：重试流走 handleStreamEvent（与首连同一入口）——捕获 `job` 帧更新
        //   currentJobId/lastStreamSeq，F5 后才能续订到重试的新作业而非首轮失败作业；
        //   逐事件落盘由 handleStreamEvent 内部完成（T04508 切页/刷新不丢进度）。
        handleStreamEvent(eventType, parsed);
      }, retryAbortController?.signal);
      // 流结束仍停在 running：没有终止事件，按「可重试的失败」收口（与 T03438 同口径）
      if (group.status === 'running') {
        group.status = 'error';
        group.retryable = true;
        group.errorMessage = deduped
          ? '相同资料已有重试正在进行，请稍后查看结果'
          : '重试连接已断开，可稍后再次重试';
      }
    } catch (err) {
      group.status = 'error';
      group.retryable = true;
      group.errorMessage = (err as Error).name === 'AbortError'
        ? '重试已中断，可再次重试'
        : `重试失败：${(err as Error).message}`;
    } finally {
      retryAbortController = null;
      retryingIndexes.value = retryingIndexes.value.filter((i) => i !== fileIndex);
      refreshBatchOutcome();
      // T05554：把收敛后的终态落盘——否则快照停在重试期间最后一次事件的 isCompiling=true，
      //   F5 后 restoreBatchSnapshot 误判「仍在编译」并续订到首轮失败作业，重贴「编译失败」。
      persistProgress();
    }
  }

  // ===== T04508：编译流生命周期归 store =====

  // 收掉在途流：先摘句柄再 abort，让被中止那一侧的 catch 认不出「自己还是当前流」
  // 为什么先置 null：abort() 是同步触发 signal 的，紧跟着的 catch 里若还能读到同一句柄，
  //   就会把「新一轮投递顶掉旧流」误判成「用户取消」而复位 isCompiling，新编译起不来
  function stopStream(): void {
    const controller = streamAbortController;
    streamAbortController = null;
    streamActive.value = false;
    controller?.abort();
  }

  // 逐事件落盘：单文件走 persistState（localStorage），批量走可序列化快照
  // 为什么在 store：组件卸载后事件仍在进这里，落盘也必须继续——否则刷新后连快照都没有
  function persistProgress(): void {
    if (isBatchMode.value) {
      persistBatchSnapshot();
      return;
    }
    persistState();
  }

  // 批量编译 UI 快照：只含可序列化字段，FormData（pendingBatchPayload）不落盘
  function persistBatchSnapshot(): void {
    if (!isBatchMode.value) return;
    saveBatchSnapshot({
      groups: batchGroups.value,
      fileCount: pendingBatchFileCount.value,
      rejected: batchRejected.value,
      isCompiling: isCompiling.value,
      isDone: isDone.value,
      isCancelled: isCancelled.value,
      errorMessage: errorMessage.value,
      doneMessage: doneMessage.value,
      jobId: currentJobId.value,
      lastSeq: lastStreamSeq.value,
    });
  }

  // 从快照恢复批量进度；返回「是否处于已中断」
  // 为什么分两支：同会话切页时 store 内存还在（实时流或刚跑完），只能用快照补中断标记，
  //   覆盖了会丢更新的分组状态；整页刷新/重开时内存为空，才需要从快照重建容器
  function restoreBatchSnapshot(): boolean {
    const snapshot = loadBatchSnapshot();
    if (isBatchMode.value) {
      // 内存里还有批量状态：流是否还活着由 streamActive 决定，不在此处判断
      return snapshot !== null && snapshot.isCompiling && !snapshot.isDone && !snapshot.isCancelled;
    }
    if (!snapshot) return false;
    if (isCompiling.value || isDone.value || isCancelled.value || errorMessage.value || pendingPayload.value) return false;
    isBatchMode.value = true;
    pendingBatchFileCount.value = snapshot.fileCount || snapshot.groups.length;
    batchRejected.value = snapshot.rejected ?? [];
    batchGroups.value = snapshot.groups;
    isCompiling.value = false;
    isDone.value = snapshot.isDone;
    isCancelled.value = snapshot.isCancelled;
    errorMessage.value = snapshot.errorMessage;
    doneMessage.value = snapshot.doneMessage;
    currentJobId.value = snapshot.jobId ?? '';
    lastStreamSeq.value = snapshot.lastSeq ?? 0;
    // T05079：F5 导航 teardown 会把在途流写成 isCompiling=false + errorMessage 的「假终态」快照，
    //   但服务端「断连不取消」，作业可能已跑完。除既有「快照仍在编译」外，只要留有 jobId 且非
    //   用户确认终态（done/cancelled），也按「已中断」上报，触发 Progress.vue 续订查后端真实终态，
    //   而不是把 teardown 残留的 network error 当编译失败直接展示。
    return (snapshot.isCompiling || !!snapshot.jobId) && !snapshot.isDone && !snapshot.isCancelled;
  }

  // 消费一条 SSE 事件：先分发状态，再落盘
  function handleStreamEvent(eventType: string, parsed: unknown): void {
    // T04550：记录事件序号，刷新/断线后从 lastSeq+1 续订
    const seq = (parsed as { seq?: unknown } | null)?.seq;
    if (typeof seq === 'number') lastStreamSeq.value = seq;
    if (eventType === 'job') {
      // 作业标识帧不是业务事件：只存 jobId（续订/取消都要用它）
      const jobId = (parsed as { jobId?: unknown } | null)?.jobId;
      if (typeof jobId === 'string' && jobId) currentJobId.value = jobId;
      persistProgress();
      return;
    }
    if (eventType === 'server-shutdown') {
      // 服务端进程要退出：作业也随之消失，重连只会拿到 404；按既有中断口径收口
      handleEvent(eventType, parsed);
      persistProgress();
      return;
    }
    handleEvent(eventType, parsed);
    persistProgress();
  }

  // 发起编译（单文件 payload 或批量 FormData）：原 Progress.vue startCompile 整体搬入
  // 为什么搬：句柄留在组件里，切页卸载就必然 abort；归 store 后组件卸载与流无关
  // 为什么返回错误文案而不是在 store 里弹 toast：store 不做 UI 副作用（同 stores/health.ts
  //   口径），请求级失败的提示仍由组件决定；errorMessage 状态位已经落好，调用方不接返回值
  //   也不会丢信息——切回页面照样看得到失败原因
  async function runCompileStream(payload: IngestPayload): Promise<string | null> {
    const controller = new AbortController();
    streamAbortController = controller;
    streamActive.value = true;
    const isFormData = payload instanceof FormData;
    const endpoint = isBatchMode.value ? `${API_BASE}/compile/batch` : `${API_BASE}/compile`;
    let fatal: string | null = null;
    try {
      // 必须走 apiFetch：T03611 原件留存按登录用户归属，裸 fetch 不带 Bearer 时
      // 后端 currentUser 为空，auth 启用部署下留存记录 ownerId=null，本人列表永远看不到。
      // 为什么用 API_BASE 拼接：vite.config.ts 的 base 为 '/wiki/'，API_BASE='/wiki/api'，
      // 仅 '/api/compile' 会绕过 vite proxy 的 '/wiki/api' 规则导致 dev 模式 404
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: isFormData ? {} : { 'Content-Type': 'application/json' },
        body: isFormData ? payload : JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await consumeSSE(response, handleStreamEvent, controller.signal);
      // T03438：流「干净结束」但不含终止事件时 fetch 不抛错，isCompiling 会永远留在 true。
      // T04550：流断了但服务端作业还在跑 → 按 jobId 续订；作业确实消失才落「已中断」。
      if (isCompiling.value && currentJobId.value && (await reconnectCompileJob())) return fatal;
      handleStreamEnd();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 中止仅在「自己仍是当前流」时才复位编译态：用户取消/重新投递都各自落过状态，
        // 被旧流残留的 reject 污染会盖掉新一轮的 isCompiling
        if (streamAbortController === controller) abortCompile();
        return null;
      }
      fatal = (err as Error).message;
      handleEvent('error', { message: fatal });
    } finally {
      if (streamAbortController === controller) {
        streamAbortController = null;
        streamActive.value = false;
      }
      persistProgress();
    }
    return fatal;
  }

  // 断点续传（单文件 runId）：原 Progress.vue startResume 整体搬入
  async function runResumeStream(runId: string): Promise<string | null> {
    // §优化方案3：resume 前保留已恢复的 stageTimings/compileStartedAt，避免 reset 清空
    // 为什么需要保留：后端 resume 从断点继续，已完成阶段的耗时不会重新产生，
    //   若不保留则切回后 stage-timings 面板为空，无法体现完整耗时分布
    const preservedTimings = { ...stageTimings.value };
    const preservedStartedAt = compileStartedAt.value;
    reset();
    stageTimings.value = preservedTimings;
    compileStartedAt.value = preservedStartedAt;
    isCompiling.value = true;
    const controller = new AbortController();
    streamAbortController = controller;
    streamActive.value = true;
    let fatal: string | null = null;
    try {
      // 无 body 的 POST 不能声明 JSON content-type：Fastify 对空 JSON body 直接回 400
      // （FST_ERR_CTP_EMPTY_JSON_BODY），用户看到的就是「点击恢复报 HTTP 400」。
      const response = await apiFetch(`${API_BASE}/compile/resume/${runId}`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await consumeSSE(response, handleStreamEvent, controller.signal);
      // T04550：resume 也走服务端作业，断流后同样尝试续订（作业不存在才落中断）
      if (isCompiling.value && currentJobId.value && (await reconnectCompileJob())) return fatal;
      handleStreamEnd();
      // T04094：续传结束后立即刷新历史列表，返回列表时状态已是后端落盘的最新值
      await loadRuns();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (streamAbortController === controller) abortCompile();
        return null;
      }
      fatal = (err as Error).message;
      handleEvent('error', { message: fatal });
    } finally {
      if (streamAbortController === controller) {
        streamAbortController = null;
        streamActive.value = false;
      }
      persistState();
    }
    return fatal;
  }

  // 用作业快照收敛终态：重放缓冲可能已裁剪掉终态帧，快照是最终事实来源
  function applyJobSnapshot(snapshot: { status?: string; message?: string } | null): void {
    if (!snapshot || isDone.value || isCancelled.value) return;
    if (snapshot.status === 'done') {
      isDone.value = true;
      isCompiling.value = false;
      // T05079：后端确认完成——清掉断连 teardown 残留的假错误与中断标记，否则 errorMessage
      //   优先于 isDone 渲染（BatchProgressBar/robotMood），红条会盖过「完成」。
      errorMessage.value = '';
      batchInterrupted.value = false;
      // 终态帧被裁剪时分组可能停在 running/pending：作业既已完成，收敛为 done（保留 error 分组）
      for (const g of batchGroups.value) {
        if (g.status === 'running' || g.status === 'pending') g.status = 'done';
      }
      if (!doneMessage.value && snapshot.message) doneMessage.value = snapshot.message;
      finishAllStages();
    } else if (snapshot.status === 'canceled') {
      isCancelled.value = true;
      isCompiling.value = false;
      finishAllStages();
    } else if (snapshot.status === 'failed') {
      errorMessage.value = snapshot.message || '编译失败';
      isCompiling.value = false;
      finishAllStages();
    }
  }

  // T04550：按 jobId 重连。刷新/断线后先查快照判断作业是否还在跑，
  // 再从 lastSeq + 1 续订事件，补齐断连窗口丢掉的帧。
  // 返回 false 表示作业不存在（服务重启/过期），调用方按既有中断口径收口。
  async function reconnectCompileJob(): Promise<boolean> {
    const jobId = currentJobId.value;
    if (!jobId) return false;
    let snapshot: { status?: string; message?: string } | null = null;
    try {
      const res = await apiFetch(`${API_BASE}/compile/jobs/${jobId}`);
      if (!res.ok) return false;
      snapshot = (await res.json()) as { status?: string; message?: string };
    } catch {
      return false;
    }
    const wasRunning = snapshot?.status === 'running';
    if (wasRunning) {
      if (isDone.value || isCancelled.value) return true;
      isCompiling.value = true;
    }
    const controller = new AbortController();
    streamAbortController = controller;
    streamActive.value = true;
    try {
      const response = await apiFetch(
        `${API_BASE}/compile/jobs/${jobId}/events?fromSeq=${lastStreamSeq.value + 1}`,
        { signal: controller.signal },
      );
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await consumeSSE(response, handleStreamEvent, controller.signal);
      if (wasRunning) {
        // 回放结束仍显示运行中：连接又断了，按既有口径声称「已中断」而不是假装成功
        handleStreamEnd();
      } else {
        applyJobSnapshot(snapshot);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') handleStreamEnd((err as Error).message);
      return false;
    } finally {
      if (streamAbortController === controller) {
        streamAbortController = null;
        streamActive.value = false;
      }
      persistProgress();
    }
    return true;
  }

  // 批量编译预存：FormData 包含多个 files 字段
  // 为什么独立 action：批量模式需要切换 isBatchMode 并初始化分组容器
  function prepareBatchCompile(payload: FormData) {
    reset();
    pendingBatchPayload.value = payload;
    // 此刻 payload 还是调用方的原始 FormData（未被响应式代理），能安全数出文件数
    try {
      pendingBatchFileCount.value = payload.getAll('files').length;
    } catch {
      pendingBatchFileCount.value = 0;
    }
    isBatchMode.value = true;
    isCompiling.value = true;
  }

  // T03613：时间线折叠规则（单文件与批量分组共用同一判据）。
  // 后端一个阶段推的是「聚合 running → 逐条 done/error → 聚合终态」，逐条追加的结果就是
  // 一条永不收口的「运行中」行留在时间线里——这正是「进度卡在 generate_tags」的观感来源。
  //  - generate_tags 是聚合阶段：整个阶段只保留一行，逐页明细滚动更新到该行；
  //  - 其他阶段：末行是同一步且仍为 running 时就地改写（终态覆盖那条开着的行），否则追加。
  function pushTimeline(list: TimelineItem[], item: TimelineItem): void {
    const last = list[list.length - 1];
    if (!last || last.step !== item.step) {
      list.push(item);
      return;
    }
    if (item.step === 'generate_tags' || last.status === 'running') {
      list[list.length - 1] = item;
      return;
    }
    list.push(item);
  }

  // 处理单条 SSE 事件，按事件类型分发
  // 批量模式事件：batch_start / file_start / progress(带 fileIndex) / page(带 fileIndex) /
  //              file_done(带 fileIndex) / file_error(带 fileIndex) / file_complete(带 fileIndex) /
  //              batch_done / error
  function handleEvent(eventType: string, data: unknown) {
    // T03438：停服收尾事件——服务端已结束流，后续不会再有 done/batch_done
    if (eventType === 'server-shutdown') {
      handleStreamEnd('服务端已重启，编译连接已中断；已完成部分不受影响，可返回投递页重试');
      return;
    }
    // 批量模式事件路由
    if (isBatchMode.value) {
      handleBatchEvent(eventType, data);
      return;
    }
    if (eventType === 'progress' || eventType === 'page') {
      const p = data as ProgressData;
      // §优化方案2：检测 step 变化时累计上一阶段耗时
      // 为什么用 currentStep.value !== p.step 判断：同一 step 多次推送事件时不累计
      if (currentStep.value !== p.step) {
        startStage(p.step);
      }
      pushTimeline(timeline.value, {
        step: p.step,
        status: p.status,
        message: p.message,
        page: extractPage(p.data),
        timestamp: Date.now()
      });
    } else if (eventType === 'deduped') {
      // T03591 幂等命中：同内容已在编译，服务端只回放快照后收流。
      // 不能算失败；记一条时间线供追溯，头部显示中性提示。
      const d = data as { message?: string; data?: { step?: string; message?: string } };
      dedupeMessage.value = d.message || '相同内容正在编译中，已复用该任务的进度';
      timeline.value.push({
        step: (d.data?.step as CompileStep) || 'archive',
        status: 'running',
        message: d.data?.message || dedupeMessage.value,
        timestamp: Date.now(),
      });
      isCompiling.value = false;
      errorMessage.value = '';
    } else if (eventType === 'done') {
      // 后端 done 事件发送的是完整 ProgressEvent：{ step, status, message, data: { path, cached?, rawPath? }, retryable? }
      // 从中提取 cached 标识和 message 供前端展示
      const d = data as { status?: string; message?: string; retryable?: boolean; data?: { cached?: boolean; path?: string } };
      // 失败态的 done 事件（status='error'）必须走错误分支，不能显示"编译完成"
      if (d.status === 'error') {
        errorMessage.value = d.message || '编译失败';
        lastErrorRetryable.value = d.retryable === true;
        isCompiling.value = false;
        isDone.value = false;
        finishAllStages();
        clearPersistedState();
        return;
      }
      lastErrorRetryable.value = false;
      // T03614：这里曾是全前端唯一的赋值点，且把 pages/indexUpdated 写死成空数组与 false，
      // 于是结果卡无论后端实际做了什么都会显示「索引更新：否」。
      // 现在改为从时间线推导：update_index 步骤收到过 done，才算索引更新；
      // 产物清单只取 generate_page（write_file）步带 page 的路径去重——时间线里 extract 等
      // 读取步同样挂 page（SCHEMA.md、raw/ 原件），全量收集会把「读了什么」当成「产出了什么」。
      const pagePaths = [
        ...new Set(
          timeline.value
            .filter((t) => t.step === 'generate_page' && t.status === 'done')
            .map((t) => t.page?.path)
            .filter((p): p is string => typeof p === 'string' && p.length > 0),
        ),
      ];
      result.value = {
        pages: pagePaths,
        indexUpdated: timeline.value.some((t) => t.step === 'update_index' && t.status === 'done'),
        cached: d.data?.cached,
      };
      // 缓存命中时 message 存在 errorMessage 上会误导，单独存到 doneMessage
      doneMessage.value = d.message ?? '';
      isCompiling.value = false;
      isDone.value = true;
      // §优化方案2：done 事件触发最后一阶段耗时累计
      finishAllStages();
      // §优化方案3：编译完成清除持久化状态
      clearPersistedState();
    } else if (eventType === 'error') {
      // 后端可能在流中推送 error 事件
      const e = data as { message?: string; retryable?: boolean };
      errorMessage.value = e?.message || '编译过程出错';
      lastErrorRetryable.value = e?.retryable === true;
      isCompiling.value = false;
      // §优化方案2：错误时同样累计最后一阶段耗时
      finishAllStages();
      // §优化方案3：出错时清除持久化状态，避免下次进入误恢复
      clearPersistedState();
    }
  }

  // 批量模式事件载荷类型
  type BatchEventData = ProgressData & {
    retryable?: boolean;
    data?: {
      fileIndex?: number;
      fileCount?: number;
      fileName?: string;
      rejected?: Array<{ name: string; reason: string }>;
      // T03591 重试：失败事件回带的存档路径与可重试语义
      rawPath?: string;
      retryable?: boolean;
      // T03591 幂等：服务端回放的进度快照字段
      state?: 'running' | 'done' | 'failed';
      startedAt?: number;
      step?: string;
      message?: string;
    };
  };

  // 处理 batch_start 事件：初始化分组容器
  function handleBatchStart(d: BatchEventData): void {
    const count = d.data?.fileCount ?? 0;
    batchRejected.value = d.data?.rejected ?? [];
    batchGroups.value = Array.from({ length: count }, (_, i) => ({
      fileIndex: i,
      fileName: '',
      status: 'pending' as const,
      timeline: [],
      pages: [],
    }));
  }

  // 处理 page 事件：同时推送到分组 timeline 与 pages 列表
  function handleBatchPage(group: BatchFileGroup, d: BatchEventData): void {
    const page = extractPage(d.data);
    pushTimeline(group.timeline, {
      step: d.step,
      status: d.status,
      message: d.message,
      page,
      timestamp: Date.now(),
    });
    if (page && !group.pages.some((p) => p.path === page.path)) {
      group.pages.push(page);
    }
  }

  // 处理 file_complete 事件：仅在 file_error 未触发时标记为完成
  function handleFileComplete(group: BatchFileGroup): void {
    if (group.status !== 'error') {
      group.status = 'done';
    }
  }

  // 处理 batch_done 事件
  function handleBatchDoneEvent(d: BatchEventData): void {
    isCompiling.value = false;
    if (d.status === 'error') {
      // 部分文件失败：整体显示错误，并保留 doneMessage 作为补充说明
      isDone.value = false;
      errorMessage.value = d.message || '批量编译部分文件失败';
    } else {
      isDone.value = true;
      // T05079：成功终态清掉断连 teardown 残留的假错误与中断标记（重连续订回放 batch_done 时同样生效）
      errorMessage.value = '';
      batchInterrupted.value = false;
    }
    doneMessage.value = d.message ?? '';
    currentStep.value = null;
  }

  // 处理 progress 事件
  function handleProgressEvent(group: BatchFileGroup, d: BatchEventData): void {
    const page = extractPage(d.data);
    pushTimeline(group.timeline, {
      step: d.step,
      status: d.status,
      message: d.message,
      page,
      timestamp: Date.now(),
    });
    // generate_page 事件（后端以 progress 发送）同步累加到分组 pages 列表，用于「生成页面：」展示。
    if (d.step === 'generate_page' && page && !group.pages.some((p) => p.path === page.path)) {
      group.pages.push(page);
    }
  }

  // 处理 file_done 事件
  function handleFileDoneEvent(group: BatchFileGroup, data: unknown): void {
    // 单文件完成：后端正常应只发 file_done 表示成功；若 status='error' 则降级为错误态兜底
    if ((data as BatchEventData).status === 'error') {
      group.status = 'error';
      group.errorMessage = (data as BatchEventData).message || '编译失败';
    } else {
      group.status = 'done';
      // T03591：重试成功后清掉上一轮的失败信息与重试入口
      group.errorMessage = '';
      group.retryable = false;
    }
  }

  // T03591 幂等命中事件：不新建任务，只回放进行中任务的进度快照。
  // 独立成函数：该分支同时负责头部中性提示与分组时间线回放，与事件分发职责不同。
  function handleBatchDedupedEvent(d: BatchEventData): void {
    const msg = d.message || '相同内容正在编译中，已复用该任务的进度';
    dedupeMessage.value = msg;
    const idx = d.data?.fileIndex;
    const group = idx === undefined ? undefined : batchGroups.value[idx];
    if (group) {
      group.timeline.push({
        step: (d.data?.step as CompileStep) || 'archive',
        status: 'running',
        message: d.data?.message || msg,
        timestamp: Date.now(),
      });
    }
    isCompiling.value = false;
  }

  // 批量模式事件分发：先处理整体事件，再按 fileIndex 路由到分组
  function handleBatchEvent(eventType: string, data: unknown) {
    const d = data as BatchEventData;

    // 整体事件：无需 fileIndex 定位分组
    if (eventType === 'batch_start') {
      handleBatchStart(d);
      return;
    }

    if (eventType === 'batch_done') {
      handleBatchDoneEvent(d);
      return;
    }

    // 不是失败——头部显示中性提示；分组重试时把快照记进该组时间线便于追溯。
    if (eventType === 'deduped' || eventType === 'batch_deduped') {
      handleBatchDedupedEvent(d);
      return;
    }

    if (eventType === 'error') {
      // 整体错误（如 multipart 解析失败）
      errorMessage.value = d.message || '批量编译过程出错';
      isCompiling.value = false;
      return;
    }

    // 分组事件：需 fileIndex 定位分组
    const idx = d.data?.fileIndex;
    if (idx === undefined) return;
    const group = batchGroups.value[idx];
    if (!group) return;

    if (eventType === 'file_start') {
      group.fileName = d.data?.fileName ?? '';
      group.status = 'running';
      currentStep.value = 'archive';
      return;
    }

    if (eventType === 'progress') {
      handleProgressEvent(group, d);
      return;
    }

    if (eventType === 'page') {
      // page 事件同时推送到全局 timeline 与分组，便于在统一视图查看
      handleBatchPage(group, d);
      return;
    }

    if (eventType === 'file_done') {
      handleFileDoneEvent(group, data);
      return;
    }

    if (eventType === 'file_error') {
      group.status = 'error';
      group.errorMessage = d.message;
      // T03591：rawPath/retryable 决定「重试」入口是否出现；缺省的旧后端保持隐藏
      group.rawPath = d.data?.rawPath ?? group.rawPath;
      group.retryable = (d.retryable ?? d.data?.retryable) === true;
      return;
    }

    if (eventType === 'file_complete') {
      // file_complete 是成功路径的终结事件，仅在 file_error 未触发时后端推送
      handleFileComplete(group);
    }
  }

  // §11.2 加载历史编译任务列表
  async function loadRuns() {
    loadingRuns.value = true;
    runsError.value = null;
    try {
      const res = await apiFetch(`${API_BASE}/compile/runs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      runs.value = data.runs ?? [];
      runsLoaded.value = true;
      runsUpdatedAt.value = new Date().toISOString();
    } catch (err) {
      // 关键：失败时【保留】已有 runs（Progress 重挂载重新 loadRuns 不应清空 Dashboard 已加载的数据），
      // 仅记录错误，由 UI 区分「加载失败」(runsError) 与「已确认空」(runsLoaded && runs.length===0)。
      // 这样 Progress 与 Dashboard 共享同一 store，不会再出现「一处有记录、一处说丢了」的矛盾。
      runsError.value = err instanceof Error ? err.message : String(err);
    } finally {
      loadingRuns.value = false;
    }
  }

  // §12.3-8 加载某个 run 的技术日志
  async function loadLog(runId: string) {
    loadingLog.value = true;
    try {
      const res = await apiFetch(`${API_BASE}/compile/runs/${runId}/log`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      logEntries.value = data.entries ?? [];
    } catch {
      logEntries.value = [];
    } finally {
      loadingLog.value = false;
    }
  }

  return {
    timeline,
    currentStep,
    isCompiling,
    isDone,
    errorMessage,
    result,
    doneMessage,
    pendingPayload,
    generatedPages,
    stepLabel,
    runs,
    loadingRuns,
    runsError,
    runsLoaded,
    runsUpdatedAt,
    logEntries,
    loadingLog,
    isBatchMode,
    pendingBatchPayload,
    pendingBatchFileCount,
    batchGroups,
    batchRejected,
    isCancelled,
    // T04508：编译流句柄与跨切页存活的在途/中断标识
    streamActive,
    batchInterrupted,
    currentJobId,
    lastStreamSeq,
    reconnectCompileJob,
    runCompileStream,
    runResumeStream,
    restoreBatchSnapshot,
    persistBatchSnapshot,
    stopStream,
    // T03591 幂等/重试
    dedupeMessage,
    retryingIndexes,
    lastErrorRetryable,
    beginRetrySingle,
    retryFileGroup,
    // 草稿批量发布状态（Browse.vue 业务，跨组件生命周期保留）
    draftBatchItems,
    draftIsPublishing,
    draftProgressMessage,
    // §优化方案1/2/3 新增字段
    stageTimings,
    currentStepStartedAt,
    compileStartedAt,
    currentRunId,
    completedStepCount,
    progressPercentage,
    totalElapsedMs,
    // §优化方案1/2/3 新增方法
    startStage,
    finishAllStages,
    persistState,
    loadPersistedState,
    clearPersistedState,
    setCurrentRunId,
    reset,
    abortCompile,
    cancelCompile,
    handleStreamEnd,
    prepareCompile,
    prepareBatchCompile,
    handleEvent,
    loadRuns,
    loadLog,
    // 草稿发布方法集
    startDraftPublish,
    startSingleDraftPublish,
    updateDraftItem,
    appendDraftItemPage,
    setDraftProgress,
    setDraftAbortController,
    abortDraftPublish,
    finalizeDraftPublish,
    clearDraftPublish,
    persistDraftPublishState,
    loadDraftPublishState,
    clearDraftPublishPersistedState,
  };
});
// 清除草稿发布持久化状态（S7721: 移到模块级避免嵌套声明）
function clearDraftPublishPersistedState(): void {
  try {
    localStorage.removeItem(DRAFT_PUBLISH_STATE_STORAGE_KEY);
  } catch {
    // 静默失败
  }
}

// 清除编译持久化状态（S7721: 移到模块级避免嵌套声明）
function clearPersistedState(): void {
  try {
    localStorage.removeItem(COMPILE_STATE_STORAGE_KEY);
  } catch {
    // 静默失败
  }
}

