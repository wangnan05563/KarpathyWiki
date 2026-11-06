# 工作空间清理台账

> 本文件是 `cleanup-config.yaml` 中 `archive.changelog_path` 的落点，由 workspace-cleanup 技能每轮追加。
> 详细审计（逐文件 SHA256）在仓库根 `logs/cleanup-*.log`，删除清单在 `logs/cleanup-deleted-manifest.txt`。

## 2026-10-31（首轮建档）

| 项 | 值 |
|---|---|
| 范围 | 全仓（根目录 + karpathy-wiki / tooling / wiki-harness / release / logs） |
| 删除 | 718 个文件 / 12 个目录 |
| 释放 | 136.75 MB（143,390,214 bytes，逻辑字节口径） |
| 失败 / 锁定 | 0 / 0 |
| 验证 | `tsc --noEmit`（api）PASS；无误删跟踪文件；外来 WIP 未裹挟 |
| 详细报告 | `logs/cleanup-report-20261031.md` |

**清理内容**

- 测试覆盖率：`karpathy-wiki/api/coverage`、`karpathy-wiki/frontend/coverage`
- 静态分析：两个 `.scannerwork`、`sonar-scan-output{2,3,4}.txt`
- 构建与编译碎片：`karpathy-wiki/.build`、`api/.build`、`wiki-harness/dist`、`frontend/tsc-out.txt`
- 工具链下载缓存：`karpathy-wiki/.cache`（pkg-fetch 的 node 运行时，87.6 MB）
- 旧产物隔离区：`frontend/.shadow_js_trash`
- 一次性探针脚本：6 个 `_smoke_*`（保留文档例外 `_smoke_inject.mjs`）
- 调试截图：`frontend/graph_after_fix.png`、`graph_head_check.png`、`verify-graph-fixed.png`
- 误建目录树：`karpathy-wiki/karpathy-wiki/`（10-29 产生的空 `api/.t036xx/iso`）
- 历史运行状态：`api/.harness/state`（107 个断点续传状态，经用户授权清除，历史续传记录不可恢复）

**显式保留（本轮未触碰）**

- `.backup-test-evidence-20261030/`：`变更日志-2026-10-30.md` 引用的回滚备份（54 文件 / 14 MB），属证据目录
- `release/spa/public_live_*`：线上伺服 SPA 源，删了会断服
- `karpathy-wiki/data/`：vault 知识内容、`wiki-index.db`、`users.json`、`audit.log`、隧道二进制
- `karpathy-wiki/data/_migrated_local_*/`：会话迁移回滚副本
- `karpathy-wiki/api/config.json`：含真实密钥的本地配置
- 各级 `logs/`：仍在写的运行日志

**防复发**

本轮全部命中既有 `.gitignore` 规则，未新增规则——`**/coverage/`、`**/.scannerwork/`、`dist/`、`.cache/`、`.build/`、`**/.harness/`、`_shadow_js_trash/`、`**/_smoke_*`、`*.log`、`*.bak`、`frontend/*.png`、`**/tsc-out.txt`、`**/sonar-scan-output*.txt` 已完整覆盖。

**同轮配置漂移修复**

- `workspace.docs_dir`：`docs` → `karpathy-wiki/docs`
- `archive.changelog_path`：`docs/CLEANUP-LOG.md` → `karpathy-wiki/docs/CLEANUP-LOG.md`（即本文件）
- `service_indicators.pid_files`：移除无任何代码引用的 `karpathy-wiki/api/logs/app.pid`
- `garbage_patterns.zero_byte_stale`：清空（目标 `data/config.json` 已不在磁盘）
- `verification.command`：根目录文件计数 → api `tsc --noEmit`；`python_imports` 清空（Node 工程无 Python 包）
