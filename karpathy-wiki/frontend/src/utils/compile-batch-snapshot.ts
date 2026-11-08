// T04095：批量编译进度快照。
// store.persistState() 因 pendingBatchPayload 是 FormData 而整支跳过批量模式，
// 于是刷新/重开后 Progress 只剩历史列表，用户在途的批量进度彻底丢失。
// 这里只持久化可序列化的 UI 快照（分组/状态/文案），不含 FormData。
import type { BatchFileGroup } from '../types';

export const BATCH_SNAPSHOT_KEY = 'wiki:compile:batch:state';

export interface BatchCompileSnapshot {
  groups: BatchFileGroup[];
  fileCount: number;
  rejected: Array<{ name: string; reason: string }>;
  isCompiling: boolean;
  isDone: boolean;
  isCancelled: boolean;
  errorMessage: string;
  doneMessage: string;
  // T04550：服务端作业标识与已收事件序号，刷新后凭二者续订补齐丢失帧
  jobId?: string;
  lastSeq?: number;
  savedAt: number;
}

export function saveBatchSnapshot(snapshot: Omit<BatchCompileSnapshot, 'savedAt'>): void {
  try {
    localStorage.setItem(BATCH_SNAPSHOT_KEY, JSON.stringify({ ...snapshot, savedAt: Date.now() }));
  } catch {
    // 存储满或被禁用时静默失败，不阻断编译流程
  }
}

export function loadBatchSnapshot(): BatchCompileSnapshot | null {
  try {
    const raw = localStorage.getItem(BATCH_SNAPSHOT_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as BatchCompileSnapshot;
    if (!Array.isArray(state.groups)) return null;
    // 没有任何可展示的状态时不恢复，避免把空壳快照当成一次编译
    if (!state.isCompiling && !state.isDone && !state.isCancelled && !state.errorMessage) return null;
    return state;
  } catch {
    return null;
  }
}

export function clearBatchSnapshot(): void {
  try {
    localStorage.removeItem(BATCH_SNAPSHOT_KEY);
  } catch {
    // 同 save：存储不可用时无需上报
  }
}
