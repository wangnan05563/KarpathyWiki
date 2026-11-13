import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineAdapter, CompileInput, BatchCompileConfig, AppConfig, ProgressEvent } from '../types.js';
import { withCompileLock } from '../compile-queue.js';
import { createSSESender, setupSSE } from '../utils/sse.js';
import {
  CompileJobManager,
  type CompileJobKind,
  type CompileJobRunner,
  type CompileJobSink,
} from '../workflows/compile-job.js';
import {
  CompileIdempotency,
  fileContentKey,
  textContentKey,
  batchContentKey,
  rawPathKey,
} from '../compile-idempotency.js';
import { isRetryableLlmError } from '../utils/llm-error.js';
import { URL_MAX_PAGES_HARD_LIMIT } from '../utils/url-crawl.js';
import type { UploadStore } from '../uploads/upload-store.js';

// 默认批量编译配置，当 index.ts 未传 config.batch 时回退使用。
// 为什么需要默认值：避免 config.json 缺失 batch 字段时路由崩溃
// 同步要求：修改时需同步更新 config.ts 的 defaultConfig().batch 与 DEFAULT_BATCH_FALLBACK
const DEFAULT_BATCH_CONFIG: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls'],
  maxBatchSize: 50,
  maxFileSizeMb: 10,
};

// T03438：编译步与步之间可能沉默数分钟（LLM 调用），心跳间隔取 15s——
// 低于常见代理 60s 空闲超时，又不会在高频事件期间产生明显流量。
const SSE_HEARTBEAT_MS = 15_000;

// 批量文件校验：剥离目录前缀 + 白名单 + 大小校验，独立为纯函数降低 batch 端点认知复杂度
type UploadedFile = { name: string; buffer: Buffer; mimeType?: string };
// 通过校验的文件：name 是供临时文件/raw 存档使用的白名单名，displayName 是用户原始名（仅用于原件留存）
type ValidatedFile = UploadedFile & { displayName: string };

function validateBatchFiles(
  uploaded: UploadedFile[],
  batch: BatchCompileConfig,
): { validFiles: ValidatedFile[]; rejected: Array<{ name: string; reason: string }> } {
  const allowedSet = new Set(batch.allowedExtensions.map((e) => e.toLowerCase()));
  const validFiles: ValidatedFile[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const maxBytes = batch.maxFileSizeMb * 1024 * 1024;
  for (const f of uploaded) {
    // basename 剥离目录前缀防路径穿越，正则替换非法字符沿用单文件模式。
    // 白名单保留 Unicode 字母/数字（含中文），避免中文文件名被替换成下划线。
    const safeName = path.basename(f.name).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (!ext) {
      rejected.push({ name: f.name, reason: '缺少扩展名' });
      continue;
    }
    if (!allowedSet.has(ext)) {
      rejected.push({ name: f.name, reason: `不支持的扩展名: ${ext}` });
      continue;
    }
    if (f.buffer.length > maxBytes) {
      rejected.push({ name: f.name, reason: `超过 ${batch.maxFileSizeMb}MB 上限` });
      continue;
    }
    validFiles.push({ ...f, name: safeName, displayName: f.name });
  }
  return { validFiles, rejected };
}

// T03591 重试入参校验：只认 vault 内 raw/<name>.md。
// 正则本身排除了多级目录、反斜杠与上跳（'../x.md' 无法匹配 [^/\\]+\.md$）。
function isSafeRawPath(p: string): boolean {
  return /^raw\/[^/\\]+\.md$/.test(p);
}

type CompileRequest =
  | { ok: true; input: CompileInput; idempotencyKey: string; uploadedFile: UploadedFile | null }
  | { ok: false; error: string };

// T03591 单文件投递解析：multipart 按上传字节算幂等键，JSON 按 type+正文。
// 从端点本体抽出来，是因为本体还要管 SSE 头、幂等占位、原件留存与串行队列，复杂度预算已经用完。
async function readCompileRequest(request: FastifyRequest): Promise<CompileRequest> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    // JSON：url 或 text
    const body = request.body as { type?: string; content?: string; rawPath?: string };
    if (!body || (body.type !== 'url' && body.type !== 'text') || !body.content) {
      return { ok: false, error: '请求体须含 type(url|text) 与 content' };
    }
    const input: CompileInput = {
      type: body.type as 'text' | 'url' | 'file',
      content: body.content ?? '',
      rawPath: body.rawPath,
    };
    return { ok: true, input, idempotencyKey: textContentKey(input.type, input.content), uploadedFile: null };
  }
  // multipart 文件上传
  const file = await request.file();
  if (!file) return { ok: false, error: '缺少 file 字段' };
  const buffer = await file.toBuffer();
  // sanitize filename：防路径穿越，剥离目录前缀并替换非法字符。
  // 白名单保留 Unicode 字母/数字（含中文），避免中文文件名被替换成下划线。
  const safeName = path.basename(file.filename).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
  // 落盘到临时目录，compile-workflow 会读取后存档到 raw/
  const tmp = path.join(os.tmpdir(), `wiki-compile-${Date.now()}-${process.pid}-${safeName}`);
  await fs.writeFile(tmp, buffer);
  return {
    ok: true,
    // 传入原始文件名（已 sanitize），供 compile-workflow 保留原名到 raw/ 存档
    input: { type: 'file', content: tmp, originalName: safeName },
    idempotencyKey: fileContentKey(buffer),
    // 留存用原始文件名（下载时尽量还原用户命名），compile 仍用白名单 safeName
    uploadedFile: { name: file.filename, buffer, mimeType: file.mimetype },
  };
}

// 批量上传收集：字段名约定为 files（复数），忽略其他字段以兼容未来扩展。
// 「解析失败」和「没上传文件」要回不同的 400 文案，所以用标记位返回而不是抛异常。
async function collectBatchUploads(
  request: FastifyRequest,
): Promise<{ files: UploadedFile[]; parseFailed: boolean }> {
  const files: UploadedFile[] = [];
  try {
    for await (const f of request.files()) {
      if (f.fieldname !== 'files') continue;
      files.push({ name: f.filename, buffer: await f.toBuffer(), mimeType: f.mimetype });
    }
  } catch (err: unknown) {
    request.log.error({ err }, 'batch compile multipart parse error');
    return { files, parseFailed: true };
  }
  return { files, parseFailed: false };
}

// 免上传重试的事件下发上下文：批量分组重试要带 fileIndex/fileCount/fileName，复用前端既有的
// file_done/file_error 分组处理；单文件重试不带（前端按顶层 done/error 处理）。
type RetryContext = {
  fileIndex?: number;
  fileCount?: number;
  fileName?: string;
  rawPath: string;
  emit: (event: string, data: unknown) => void;
};

// fileIndex 缺省时原样透传，避免单文件重试的 data 里多出无意义字段
function withRetryGroup(ctx: RetryContext, ev: ProgressEvent) {
  if (ctx.fileIndex === undefined) return ev;
  return {
    ...ev,
    data: { ...ev.data, fileIndex: ctx.fileIndex, fileCount: ctx.fileCount, fileName: ctx.fileName },
  };
}

// 转发一条重试进度事件；done 事件按「单文件 / 批量分组」两种语义下发，并回传该事件的终态。
function emitRetryEvent(ctx: RetryContext, ev: ProgressEvent): 'done' | 'failed' | undefined {
  const payload = withRetryGroup(ctx, ev);
  if (ev.step !== 'done') {
    ctx.emit(ev.data?.path && ev.data?.title ? 'page' : 'progress', payload);
    return undefined;
  }
  if (ctx.fileIndex === undefined) {
    ctx.emit('done', payload);
  } else if (ev.status === 'error') {
    // 批量分组重试：沿用 file_error，前端既有处理会刷新分组错误态与重试入口
    ctx.emit('file_error', {
      step: 'finalize',
      status: 'error',
      message: ev.message || '编译失败',
      data: {
        fileIndex: ctx.fileIndex,
        fileCount: ctx.fileCount,
        fileName: ctx.fileName,
        rawPath: ctx.rawPath,
        retryable: ev.retryable,
      },
      retryable: ev.retryable,
    });
  } else {
    ctx.emit('file_done', payload);
  }
  return ev.status === 'error' ? 'failed' : 'done';
}

// 重试流异常：单文件回顶层 error，批量分组回 file_error（前端两套处理）
function emitRetryFailure(ctx: RetryContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const retryable = isRetryableLlmError(err);
  if (ctx.fileIndex === undefined) {
    ctx.emit('error', { step: 'finalize', status: 'error', message, retryable });
    return;
  }
  ctx.emit('file_error', {
    step: 'finalize',
    status: 'error',
    message,
    data: {
      fileIndex: ctx.fileIndex,
      fileCount: ctx.fileCount,
      fileName: ctx.fileName,
      rawPath: ctx.rawPath,
      retryable,
    },
    retryable,
  });
}

// 注册 POST /api/compile 与 POST /api/compile/batch 路由。
// 单文件端点接受两种 Content-Type：
//   - multipart/form-data：file 字段上传单文件
//   - application/json：{ type: 'url'|'text', content: string }
// 批量端点仅接受 multipart/form-data：files 字段（多值）上传文件夹扫描结果。
// 响应均为 SSE 流，事件格式：event: <type>\ndata: <json>\n\n
// 批量端点 data 字段扩展 fileIndex/fileCount/fileName 以便前端按文件分组渲染。
export function registerCompileRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  batchConfig?: BatchCompileConfig,
  // FR-10-1: 传入完整 config 用于 compile 末尾生成 ai_tags 建议（调用 LLM）
  appConfig?: AppConfig,
  // T03611：投递时留存原始文档（data/uploads/）。未传则关闭留存，既有单测/部署行为不变。
  uploadStore?: UploadStore | null,
) {
  const batch = batchConfig ?? DEFAULT_BATCH_CONFIG;

  // T03611：留存原始文档。失败只记 warn 不抛出——留档是附加能力，
  // 不能因为磁盘满/权限问题把一次正常投递变成 500。
  async function retainOriginal(
    request: FastifyRequest,
    file: UploadedFile,
    source: 'file' | 'batch',
  ): Promise<void> {
    if (!uploadStore) return;
    try {
      await uploadStore.save({
        name: file.name,
        buffer: file.buffer,
        mimeType: file.mimeType,
        ownerId: request.currentUser?.userId ?? null,
        ownerName: request.currentUser?.username ?? null,
        source,
      });
    } catch (err) {
      request.log.warn({ err, fileName: file.name }, '原始文档留存失败（不影响编译）');
    }
  }
  // T03591 幂等表：按内容指纹挡住「同一份内容正在编译」的重复/并发提交。
  // 每个 route 注册对应一个实例（进程内、单测可隔离），语义见 compile-idempotency.ts。
  const idempotency = new CompileIdempotency();
  // T04550：编译作业注册表。作业与 HTTP 连接解耦——断连只退订，显式 cancel 才停。
  const jobs = new CompileJobManager();

  // 建立连接并启动作业：job 事件先于所有业务事件下发，前端据此持久化 jobId 供刷新重连。
  function startJobOnConnection(
    request: FastifyRequest,
    reply: FastifyReply,
    sender: ReturnType<typeof createSSESender>,
    kind: CompileJobKind,
    runner: CompileJobRunner,
  ): void {
    const snapshot = jobs.start(kind, runner);
    sender.send('job', { jobId: snapshot.jobId, kind, status: 'running', lastSeq: 0 });
    const sink: CompileJobSink = {
      // createSSESender 不写 SSE id 字段，seq 只能随 data 下发，供前端 fromSeq 续订
      onEvent: (event, data, seq) => {
        sender.send(event, data && typeof data === 'object'
          ? { ...(data as Record<string, unknown>), seq }
          : data);
      },
      isAborted: sender.isAborted,
      end: sender.safeEnd,
    };
    jobs.subscribe(snapshot.jobId, sink, 0);
    // 连接断开只解除订阅：作业继续在后台跑，刷新后凭 jobId 续订回放
    reply.raw.on('close', () => jobs.unsubscribe(snapshot.jobId, sink));
  }

  app.post('/api/compile', {
    // 破坏性端点更严格限流：compile 触发 LLM + 写 vault，10/min 防滥用
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = await readCompileRequest(request);
    if (!parsed.ok) return void reply.code(400).send({ error: parsed.error });
    const { input, idempotencyKey, uploadedFile } = parsed;

    // SSE headers。Connection: keep-alive 防代理断开，X-Accel-Buffering: no 防 Nginx 缓冲。
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
    const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });

    // 幂等占位：同内容已在编译 → 回放当前进度快照后直接收流，不新建任务
    const begun = idempotency.begin(idempotencyKey);
    if (begun.kind === 'running') {
      sender.send('deduped', {
        step: 'deduped',
        status: 'running',
        message: '相同内容正在编译中，已复用该任务的进度',
        data: { ...begun.snapshot },
      });
      sender.safeEnd();
      if (input.type === 'file') {
        await fs.unlink(input.content).catch(() => {});
      }
      return;
    }
    const idempotencyToken = begun.token;
    // T03611：幂等命中不算一次新投递，只有真正开始编译才留存原件
    if (uploadedFile) await retainOriginal(request, uploadedFile, 'file');
    let streamStatus: 'done' | 'failed' = 'failed';
    let lastMessage: string | undefined;

    // T04550：runner 只认「显式取消」，不再看连接状态——刷新断连不中断编译
    const runner: CompileJobRunner = async (ctx) => {
      try {
        // §12.3-5：串行队列包装，保证并发 compile 请求不产生 index.md/log.md 追加竞态。
        await withCompileLock(async () => {
          for await (const ev of adapter.compile(input, appConfig)) {
            // 用户显式取消：提前退出迭代避免继续触发 LLM 调用与 vault 写入
            if (ctx.cancelled()) break;
            lastMessage = ev.message;
            idempotency.touch(idempotencyKey, { step: ev.step, message: ev.message });
            // 区分进度事件与页面生成事件：data 含 path/title 视为 page 事件
            // FR-10-1: generate_tags 步骤归为 progress 事件（无 path/title）
            if (ev.step === 'done') {
              streamStatus = ev.status === 'error' ? 'failed' : 'done';
              ctx.emit('done', ev);
            } else if (ev.data?.path && ev.data?.title) {
              ctx.emit('page', ev);
            } else {
              ctx.emit('progress', ev);
            }
          }
        });
      } catch (err: unknown) {
        // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
        request.log.error(
          { err, inputType: input.type },
          'compile SSE stream error',
        );
        streamStatus = 'failed';
        ctx.emit('error', {
          step: 'finalize',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: isRetryableLlmError(err),
        });
      } finally {
        // 中断（用户取消）也按 failed 收口：否则同内容会被一直挡在「编译中」直到 TTL 过期
        idempotency.finish(idempotencyKey, idempotencyToken, {
          status: ctx.cancelled() ? 'failed' : streamStatus,
          message: lastMessage,
        });
        // 清理临时文件：仅 file 模式落盘了临时文件，避免 tmp 目录残留泄漏
        if (input.type === 'file') {
          await fs.unlink(input.content).catch(() => {});
        }
      }
      return { status: streamStatus, message: lastMessage };
    };
    startJobOnConnection(request, reply, sender, 'single', runner);
  });

  // §11.2 断点续传：POST /api/compile/resume/:runId
  // 从中断点恢复编译，SSE 流式返回进度事件（同 /api/compile 格式）
  app.post<{ Params: { runId: string } }>(
    '/api/compile/resume/:runId',
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：只允许 UUID 格式的 runId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        // 必须 return：否则后续 raw.writeHead 会在已发送 400 之后二次写头
        return void reply.code(400).send({ error: '无效的 runId' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
      const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });

      const runner: CompileJobRunner = async (ctx) => {
        let status: 'done' | 'failed' = 'done';
        try {
          await withCompileLock(async () => {
            for await (const ev of adapter.resumeCompile(runId)) {
              // 用户显式取消：提前退出迭代避免继续触发 LLM 调用与 vault 写入
              if (ctx.cancelled()) break;
              if (ev.step === 'done') {
                status = ev.status === 'error' ? 'failed' : 'done';
                ctx.emit('done', ev);
              } else if (ev.data?.path && ev.data?.title) {
                ctx.emit('page', ev);
              } else {
                ctx.emit('progress', ev);
              }
            }
          });
        } catch (err: unknown) {
          // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
          request.log.error(
            { err, runId },
            'compile resume SSE stream error',
          );
          status = 'failed';
          ctx.emit('error', {
            step: 'finalize',
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return { status };
      };
      startJobOnConnection(request, reply, sender, 'resume', runner);
    },
  );

  // 批量编译端点：POST /api/compile/batch
  // 接收 multipart 多文件（字段名 files），按顺序串行编译每个文件，SSE 推送进度。
  // 为什么不并行：withCompileLock 是全局串行队列，batch 内部已串行；
  //   并行编译会导致 index.md/log.md 追加竞态（与单文件 compile 同理）
  // 为什么 batch 限流更严格（5/min）：批量端点单请求触发多次 LLM 调用，比单文件消耗更多 token
  app.post('/api/compile/batch', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 收集所有上传的文件：request.files() 是 async iterator
    const upload = await collectBatchUploads(request);
    if (upload.parseFailed) {
      reply.code(400).send({ error: '文件解析失败' });
      return;
    }
    const uploaded = upload.files;

    if (uploaded.length === 0) {
      reply.code(400).send({ error: '缺少 files 字段或文件为空' });
      return;
    }

    // 扩展名白名单校验：为什么用白名单而非黑名单：黑名单无法覆盖所有危险类型（如 .exe/.js），白名单更安全
    const { validFiles, rejected } = validateBatchFiles(uploaded, batch);

    if (validFiles.length === 0) {
      reply.code(400).send({
        error: '没有符合白名单的文件',
        rejected,
      });
      return;
    }

    // 批量大小上限校验：防止单请求触发过多 LLM 调用导致 token 耗尽
    if (validFiles.length > batch.maxBatchSize) {
      reply.code(400).send({
        error: `批量编译文件数 ${validFiles.length} 超过上限 ${batch.maxBatchSize}`,
      });
      return;
    }

    // T03591 批量幂等 Key：对每个文件的内容 key 排序后再哈希，选择顺序不影响判定
    const batchKey = batchContentKey(validFiles.map((f) => fileContentKey(f.buffer)));

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
    const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });

    // 幂等占位：同一文件集合正在编译 → 回放当前进度快照，不再启动第二轮 LLM 调用
    const begun = idempotency.begin(batchKey);
    if (begun.kind === 'running') {
      sender.send('batch_deduped', {
        step: 'batch_done',
        status: 'running',
        message: '相同文件集合正在批量编译中，已复用该任务的进度',
        data: { ...begun.snapshot, fileCount: validFiles.length },
      });
      sender.safeEnd();
      return;
    }
    const idempotencyToken = begun.token;
    // T03611：只为通过白名单/大小校验的文件留存原件（被拒绝的文件未构成一次投递）
    for (const f of validFiles) {
      await retainOriginal(request, { name: f.displayName || f.name, buffer: f.buffer, mimeType: f.mimeType }, 'batch');
    }

    const fileCount = validFiles.length;
    // T04550：整批是一个后台作业，断连不中断；batch_start 也要进缓冲，重连时前端才有分组容器
    const runner: CompileJobRunner = async (ctx) => {
      // 临时文件路径列表，无论成功失败都需清理
      const tmpPaths: string[] = [];
      const batchCtx: BatchFileContext = {
        adapter,
        appConfig,
        idempotency,
        batchKey,
        fileCount,
        emit: ctx.emit,
        cancelled: ctx.cancelled,
        log: request.log,
      };

      // 推送文件列表与被拒绝项，前端据此渲染初始分组
      ctx.emit('batch_start', {
        step: 'batch_start',
        status: 'running',
        message: `开始批量编译 ${fileCount} 个文件`,
        data: {
          fileCount,
          rejected,
        },
      });

      let batchHasError = false;
      try {
        // batch 整体作为 withCompileLock 的一个任务，保证与其他 compile/resume 请求串行
        await withCompileLock(async () => {
          batchHasError = await runBatchFiles(batchCtx, validFiles, tmpPaths);
        });

        // 整体完成事件：任一文件失败即标记为 error，让批量结果页正确显示"出错了"
        ctx.emit('batch_done', {
          step: 'done',
          status: batchHasError ? 'error' : 'done',
          message: batchHasError
            ? `批量编译完成，但部分文件失败，请查看下方文件详情`
            : `批量编译完成，共处理 ${fileCount} 个文件`,
          data: { fileCount, hasError: batchHasError },
        });
      } catch (err: unknown) {
        request.log.error({ err }, 'batch compile SSE stream error');
        batchHasError = true;
        ctx.emit('error', {
          step: 'finalize',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // T03591：用户取消同样收口为 failed，允许稍后重试同一文件集合；
        // 只有整批跑完且无失败文件才记为 done。
        idempotency.finish(batchKey, idempotencyToken, {
          status: ctx.cancelled() || batchHasError ? 'failed' : 'done',
          message: batchHasError ? '部分文件失败' : undefined,
        });
        // 清理临时文件：避免 tmp 目录残留
        for (const tmp of tmpPaths) {
          await fs.unlink(tmp).catch(() => {});
        }
      }
      return { status: batchHasError ? 'failed' : 'done' };
    };
    startJobOnConnection(request, reply, sender, 'batch', runner);
  });

  // ==========================================================================
  // T05721：URL 爬取结果逐页编译  POST /api/compile/url-pages
  // 入参 JSON：{ pages: [{ name: string; markdown: string }] }
  // 出参 SSE：与 /api/compile/batch 同构（batch_start → file_start → progress/page →
  //   file_done|file_error → file_complete → batch_done），前端复用 isBatchMode 与
  //   BatchProgressBar 的分组统计，无需新增事件类型。
  //
  // 为什么不复用 multipart batch 端点：
  //   ① config.batch.maxBatchSize 默认 50，而 URL 爬取允许到 500 页 —— 60 页会被拒；
  //   ② multipart 单文件 10MB 上限会剔除超长页面，使「入队页数 < 解析页数」，
  //      成功率分母失真；
  //   ③ 爬取内容不是用户主动上传的原始文档，不应进「已投递原始文档」留存列表。
  // 为什么按页独立编译：验收口径「成功率 = 成功编译数 / 总解析页面数」要求每页是
  //   独立编译单元；合并成一份 text 时分子恒为 1，成功率恒为 1/N，指标无意义。
  // 为什么与 batch 端点各写一份 runner：T02818 源码序守护按文本顺序判定
  //   「adapter.compile 消费发生在 withCompileLock 内」，抽取公共 runner 会打散该
  //   文本序；两份 runner 保持同构，任一处改动需同步另一处。
  // 体积：Fastify 全局 bodyLimit=50MB（index.ts），覆盖 500 页 × 4M 字符封顶后的典型值。
  // ==========================================================================
  app.post('/api/compile/url-pages', {
    // 单请求触发 N 次 LLM 编译，与批量端点同额度
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { pages?: unknown };
    const rawPages = body.pages;
    if (!Array.isArray(rawPages) || rawPages.length === 0) {
      return void reply.code(400).send({ error: '缺少 pages 字段或页面为空' });
    }
    if (rawPages.length > URL_MAX_PAGES_HARD_LIMIT) {
      return void reply.code(400).send({
        error: `URL 页面数 ${rawPages.length} 超过上限 ${URL_MAX_PAGES_HARD_LIMIT}`,
      });
    }

    // 逐项结构校验。为什么不复用 validateBatchFiles：它会按 maxFileSizeMb 静默剔除
    //   超长页面，导致「入队页数 < 解析页数」；URL 正文已被 extractHtmlContent 在
    //   4M 字符处封顶，这里只做类型与路径穿越防护，保证分母恒等于解析页数。
    const validFiles: ValidatedFile[] = [];
    for (const raw of rawPages) {
      const p = raw as { name?: unknown; markdown?: unknown } | null;
      if (!p || typeof p.name !== 'string' || typeof p.markdown !== 'string' || !p.markdown.trim()) {
        return void reply.code(400).send({ error: 'pages 每项须含非空 name 与 markdown 字符串' });
      }
      // name 只作临时文件名与前端分组标题：禁止目录分隔符与上跳，避免路径穿越
      if (!/^[^/\\]+\.md$/.test(p.name)) {
        return void reply.code(400).send({ error: `页面文件名非法: ${p.name}` });
      }
      validFiles.push({
        name: path.basename(p.name).replaceAll(/[^\p{L}\p{N}._-]/gu, '_'),
        displayName: p.name,
        buffer: Buffer.from(p.markdown, 'utf8'),
        mimeType: 'text/markdown',
      });
    }

    const fileCount = validFiles.length;
    const rejected: Array<{ name: string; reason: string }> = [];
    const batchKey = batchContentKey(validFiles.map((f) => fileContentKey(f.buffer)));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });

    const begun = idempotency.begin(batchKey);
    if (begun.kind === 'running') {
      sender.send('batch_deduped', {
        step: 'batch_done',
        status: 'running',
        message: '相同页面集合正在逐页编译中，已复用该任务的进度',
        data: { ...begun.snapshot, fileCount },
      });
      sender.safeEnd();
      return;
    }
    const idempotencyToken = begun.token;
    // URL 页面不调 retainOriginal：原件留存列表只收录用户主动上传的文件

    const runner: CompileJobRunner = async (ctx) => {
      const tmpPaths: string[] = [];
      const batchCtx: BatchFileContext = {
        adapter, appConfig, idempotency, batchKey, fileCount,
        emit: ctx.emit, cancelled: ctx.cancelled, log: request.log,
      };
      ctx.emit('batch_start', {
        step: 'batch_start',
        status: 'running',
        message: `开始逐页编译 ${fileCount} 个页面`,
        data: { fileCount, rejected },
      });

      let hasError = false;
      try {
        await withCompileLock(async () => {
          hasError = await runBatchFiles(batchCtx, validFiles, tmpPaths);
        });
        ctx.emit('batch_done', {
          step: 'done',
          status: hasError ? 'error' : 'done',
          message: hasError
            ? `逐页编译结束：${fileCount} 个页面中有失败项，请查看成功率与失败详情`
            : `逐页编译完成，共处理 ${fileCount} 个页面`,
          data: { fileCount, hasError },
        });
      } catch (err: unknown) {
        request.log.error({ err }, 'url-pages compile SSE stream error');
        hasError = true;
        ctx.emit('error', {
          step: 'finalize',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        idempotency.finish(batchKey, idempotencyToken, {
          status: ctx.cancelled() || hasError ? 'failed' : 'done',
          message: hasError ? '部分页面失败' : undefined,
        });
        for (const tmp of tmpPaths) {
          await fs.unlink(tmp).catch(() => {});
        }
      }
      return { status: hasError ? 'failed' : 'done' };
    };
    startJobOnConnection(request, reply, sender, 'batch', runner);
  });

  // T03591 免上传重试：POST /api/compile/retry
  // 入参 JSON：{ rawPath, fileName?, fileIndex?, fileCount? }
  //   - rawPath：上游失败事件 data.rawPath 回带的存档路径（vault 内 raw/<name>.md）
  //   - fileIndex/fileCount/fileName：批量分组上下文；提供时按 file_done/file_error 语义回推，
  //     复用前端已有的批量分组事件处理，不额外发明事件类型
  // 出参：SSE，事件类型与 /api/compile 一致（progress/page/done）；重复提交回 deduped
  app.post('/api/compile/retry', {
    // 与单文件 compile 同额度：重试同样触发一次 LLM 编译
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as {
      rawPath?: unknown;
      fileName?: unknown;
      fileIndex?: unknown;
      fileCount?: unknown;
    };
    const rawPath = body.rawPath;
    if (typeof rawPath !== 'string' || !isSafeRawPath(rawPath)) {
      return void reply.code(400).send({ error: 'rawPath 须为 raw/ 目录下的 .md 相对路径' });
    }
    if (!adapter.compileFromRaw) {
      return void reply.code(501).send({ error: '当前引擎不支持从存档重试' });
    }
    const fileIndex = typeof body.fileIndex === 'number' ? body.fileIndex : undefined;
    const fileCount = typeof body.fileCount === 'number' ? body.fileCount : undefined;
    const fileName = typeof body.fileName === 'string' ? body.fileName : undefined;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });

    const retryKey = rawPathKey(rawPath);
    const begun = idempotency.begin(retryKey);
    if (begun.kind === 'running') {
      sender.send('deduped', {
        step: 'deduped',
        status: 'running',
        message: '这份资料正在重新编译中，已复用该任务的进度',
        data: { ...begun.snapshot, fileIndex, fileCount, fileName },
      });
      sender.safeEnd();
      return;
    }
    const idempotencyToken = begun.token;
    let streamStatus: 'done' | 'failed' = 'failed';
    let lastMessage: string | undefined;

    // T04550：重试同样作为后台作业，刷新断连不中断
    const runner: CompileJobRunner = async (ctx) => {
      const retryCtx: RetryContext = { fileIndex, fileCount, fileName, rawPath, emit: ctx.emit };
      try {
        await withCompileLock(async () => {
          for await (const ev of adapter.compileFromRaw!(rawPath)) {
            if (ctx.cancelled()) break;
            lastMessage = ev.message;
            idempotency.touch(retryKey, { step: ev.step, message: ev.message });
            const outcome = emitRetryEvent(retryCtx, ev);
            if (outcome) streamStatus = outcome;
          }
        });
      } catch (err: unknown) {
        request.log.error({ err, rawPath }, 'compile retry SSE stream error');
        streamStatus = 'failed';
        emitRetryFailure(retryCtx, err);
      } finally {
        idempotency.finish(retryKey, idempotencyToken, {
          status: ctx.cancelled() ? 'failed' : streamStatus,
          message: lastMessage,
        });
      }
      return { status: streamStatus, message: lastMessage };
    };
    startJobOnConnection(request, reply, sender, 'retry', runner);
  });

  // T04550：作业状态查询。前端刷新后先查它判断「还在跑 / 已终态」，再决定是否续订事件。
  app.get<{ Params: { jobId: string } }>(
    '/api/compile/jobs/:jobId',
    async (request, reply) => {
      const snapshot = jobs.getSnapshot(request.params.jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });
      void reply.send(snapshot);
    },
  );

  // T04550：事件续订。先回放 seq >= fromSeq 的缓冲事件，再转为直播；终态作业回放后直接收流。
  app.get<{ Params: { jobId: string }; Querystring: { fromSeq?: string } }>(
    '/api/compile/jobs/:jobId/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { jobId } = request.params as { jobId: string };
      const snapshot = jobs.getSnapshot(jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });

      setupSSE(reply);
      const sender = createSSESender(reply, request, { heartbeatMs: SSE_HEARTBEAT_MS });
      const sink: CompileJobSink = {
        onEvent: (event, data, seq) => {
          sender.send(event, data && typeof data === 'object'
            ? { ...(data as Record<string, unknown>), seq }
            : data);
        },
        isAborted: sender.isAborted,
        end: sender.safeEnd,
      };
      const raw = Number((request.query as { fromSeq?: string }).fromSeq);
      const fromSeq = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      // 先回快照：缓冲可能已裁剪掉终态帧，前端凭 status 仍能落到正确终态
      sender.send('job', { ...snapshot });
      jobs.subscribe(jobId, sink, fromSeq);
      reply.raw.on('close', () => jobs.unsubscribe(jobId, sink));
    },
  );

  // T04550：显式取消。只置标记由 runner 在检查点退出；断连不再推断为用户取消。
  app.post<{ Params: { jobId: string } }>(
    '/api/compile/jobs/:jobId/cancel',
    async (request, reply) => {
      const snapshot = jobs.cancel(request.params.jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });
      void reply.send(snapshot);
    },
  );
}

// 批量逐文件编译的实现体。刻意放在注册函数之后：批量链的 adapter.compile 消费点
// 必须出现在首个 `await withCompileLock(` 之后（T02818 源码序守护用例按文本顺序判定
// 「消费发生在锁内」），且这两个函数只在该锁内被调用。
// 批量编译的执行上下文：批量端点本体还要做校验、幂等占位与原件留存，
// 逐文件消费事件流的逻辑按此上下文外提，避免单函数认知复杂度超限。
type BatchFileContext = {
  adapter: EngineAdapter;
  appConfig?: AppConfig;
  idempotency: CompileIdempotency;
  batchKey: string;
  fileCount: number;
  emit: (event: string, data: unknown) => void;
  cancelled: () => boolean;
  log: FastifyRequest['log'];
};

// 单个文件的编译流式推送；返回值表示该文件是否成功（用于决定是否发送 file_complete 事件）
async function streamBatchFileCompile(
  ctx: BatchFileContext,
  input: CompileInput,
  fileIndex: number,
  fileName: string,
): Promise<boolean> {
  let fileFailed = false;
  const { adapter, appConfig, idempotency, batchKey, fileCount, emit, cancelled, log } = ctx;
  try {
    for await (const ev of adapter.compile(input, appConfig)) {
      // 客户端已断开：提前退出迭代，停止当前文件的剩余步骤
      if (cancelled()) break;
      // T03591：让后来的重复提交能看到「当前编译到哪个文件/哪一步」
      idempotency.touch(batchKey, { step: ev.step, message: `${fileName}: ${ev.message}` });
      // 把 fileIndex/fileCount/fileName 注入到每个事件的 data，前端按 fileIndex 路由到对应分组
      const evWithData = {
        ...ev,
        data: {
          ...ev.data,
          fileIndex,
          fileCount,
          fileName,
        },
      };
      if (ev.step === 'done') {
        // 单文件编译失败时，done 事件的 status 为 error，必须转发为 file_error，
        // 避免前端把失败误标为 DONE（之前 0 页面且显示成功即因此）。
        // T03591：失败事件透传 rawPath/retryable，前端据此显示「免上传重试」入口。
        if (ev.status === 'error') {
          fileFailed = true;
          emit('file_error', {
            step: 'finalize',
            status: 'error',
            message: ev.message || '编译失败',
            data: {
              fileIndex,
              fileCount,
              fileName,
              rawPath: ev.data?.rawPath,
              retryable: ev.retryable,
            },
            retryable: ev.retryable,
          });
        } else {
          emit('file_done', evWithData);
        }
      } else if (ev.data?.path && ev.data?.title) {
        emit('page', evWithData);
      } else {
        emit('progress', evWithData);
      }
    }
  } catch (err: unknown) {
    fileFailed = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      { err, fileName, fileIndex },
      'batch compile file error',
    );
    emit('file_error', {
      step: 'finalize',
      status: 'error',
      message: `文件 ${fileName} 编译失败: ${errMsg}`,
      data: { fileIndex, fileCount, fileName, retryable: isRetryableLlmError(err) },
      retryable: isRetryableLlmError(err),
    });
  }
  return !fileFailed;
}

// 逐个文件走一遍「落盘 → file_start → 编译推流 → file_complete」，tmpPaths 由调用方负责清理。
// 返回是否出现失败文件，用于收口 batch_done 与幂等终态。
async function runBatchFiles(
  ctx: BatchFileContext,
  files: ValidatedFile[],
  tmpPaths: string[],
): Promise<boolean> {
  let hasError = false;
  for (let i = 0; i < files.length; i++) {
    // 客户端已断开：提前退出循环，停止后续文件编译避免无谓 LLM 调用
    if (ctx.cancelled()) break;
    const f = files[i];
    // 落盘到临时文件：compile-workflow 通过 fs.readFile 读取后存档到 raw/
    const tmp = path.join(os.tmpdir(), `wiki-batch-${Date.now()}-${process.pid}-${i}-${f.name}`);
    await fs.writeFile(tmp, f.buffer);
    tmpPaths.push(tmp);

    // 单文件开始事件：前端据此创建分组容器
    ctx.emit('file_start', {
      step: 'archive',
      status: 'running',
      message: `开始编译文件 ${i + 1}/${ctx.fileCount}: ${f.name}`,
      data: { fileIndex: i, fileCount: ctx.fileCount, fileName: f.name },
    });

    const input: CompileInput = { type: 'file', content: tmp, originalName: f.name };
    if (!(await streamBatchFileCompile(ctx, input, i, f.name))) {
      hasError = true;
      continue;
    }
    // 文件结束事件：标记该分组完成（仅成功时），前端据此切换 UI 状态
    ctx.emit('file_complete', {
      step: 'finalize',
      status: 'done',
      message: `文件 ${i + 1}/${ctx.fileCount} 完成: ${f.name}`,
      data: { fileIndex: i, fileCount: ctx.fileCount, fileName: f.name },
    });
  }
  return hasError;
}
