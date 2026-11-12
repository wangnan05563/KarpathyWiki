#Requires -Version 5.1
# Karpathy-Wiki 一键发布主逻辑
# 流程：[按需自动打包] -> 安装依赖 -> 发布门禁 -> 构建前端 SPA -> 部署到 live -> 重启生产服务 -> 健康检查 -> 发布 GitHub Release
# 配置驱动：所有命令/路径从 scripts/config.json 的 publish 节读取，无硬编码
# 分层：本脚本由 一键发布.bat 调用，.bat 仅作纯 ASCII 入口

param(
    [string]$ConfigPath = "$PSScriptRoot\config.json",
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    # T04910：跳过发布门禁（pnpm gate）。默认发布/部署前执行双侧 gate，失败即停
    [switch]$SkipGate,
    [switch]$SkipDeploy,
    [switch]$SkipRestart,
    # 默认发布 GitHub Release；只想部署 SPA（不发 Release）时加 -SkipPublish
    [switch]$SkipPublish,
    # T02743：显式指定本次发布的正式 Release 说明文件（发布时落地为约定名 release-notes-<版本>.md）
    [string]$ReleaseNotesFile = '',
    # 版本匹配的安装包缺失时，自动联动 scripts\build-exe.ps1 打好包再继续发布（默认开启）
    [switch]$NoAutoBuild,
    # 强制重打最新包：即使当前版本已有安装包也重建（用于「代码变了但版本号没变」）
    [switch]$RebuildPackage,
    # 恢复 T02743 严格口径：缺少正式说明时阻断，不自动生成草稿
    [switch]$StrictNotes,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# 控制台 UTF-8 输出（避免中文乱码，对应 create-bat 规则 4 / F4）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null

# 加载配置
if (-not (Test-Path $ConfigPath)) { throw "配置文件不存在: $ConfigPath" }
$Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# 切换到项目根目录（config.project.root 相对 scripts/）
$Root = (Resolve-Path (Join-Path $PSScriptRoot $Config.project.root)).Path
Set-Location $Root

# 共享日志 + node 解析模块
. (Join-Path $PSScriptRoot 'logger.ps1')
Initialize-Logger -Config $Config
. (Join-Path $PSScriptRoot 'node-resolver.ps1')
$NodeExe = Resolve-NodeExe -Config $Config
if (-not $NodeExe) { Write-Log "未解析到 node.exe，请检查 config.tools.node" -Level ERROR; exit 1 }
Invoke-WithNodePath -NodeExePath $NodeExe

# 包管理器检测（auto -> pnpm > npm）
$pkgManager = $Config.commands.pkg_manager
if ($pkgManager -eq 'auto') {
    if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { $pkgManager = 'pnpm.cmd' }
    else { $pkgManager = 'npm.cmd' }
} elseif ($pkgManager -eq 'pnpm') { $pkgManager = 'pnpm.cmd' }
elseif ($pkgManager -eq 'npm') { $pkgManager = 'npm.cmd' }
if (-not (Get-Command $pkgManager -ErrorAction SilentlyContinue)) {
    Write-Log "包管理器不可用: $pkgManager" -Level ERROR; exit 1
}

# 安装参数按包管理器区分：pnpm >= 10 拒绝 npm 兼容参数 --no-audit/--no-fund（报 Unknown options），仅 npm 需要
$installArgs = @('install')
if ($pkgManager -eq 'npm.cmd') { $installArgs = @('install', '--no-audit', '--no-fund') }

$apiPort = [int]$Config.ports.api
$p = $Config.publish
$buildArgs = $p.build_args
$prodStartArgs = $p.prod_start_args
$buildLog = Join-Path $Root $p.build_log_file
$prodLog = Join-Path $Root $p.prod_log_file
$deployScript = Join-Path $Root $p.deploy_script
$deploySrc = $p.deploy_src
$healthUrl = "http://localhost:$apiPort$($p.health_path)"
$spaUrl = "http://localhost:$apiPort$($p.spa_probe_path)"

# 计算的部署目标目录（与 spa-resolver.ts 的 api/../../release/spa 一致）
$deployTargetDir = Join-Path (Join-Path (Join-Path (Split-Path $deployScript) '..') '..') (Join-Path 'release' 'spa')

function Join-Args([array]$a) { return ($a -join ' ') }

# Inno Setup 编译器探测（与 build-exe.ps1 的 Find-ISCC 同口径）。
# 为什么要在这里重复探测：build-exe 在 Inno 不可用时只打一行 WARN「跳过安装包制作」并**仍以 0 退出**，
# 于是「自动打包成功但没有安装包」会表现成一句模糊的「仍未找到匹配版本的包」。这里把真因点出来。
function Find-InnoCompiler {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cands = @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe',
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "$env:USERPROFILE\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($c in $cands) { if (Test-Path $c) { return $c } }
    return $null
}

# 自动生成 Release 说明草稿（仅用于「一键发布补齐」，见下方步骤 0）。
# 口径变更（T02743 → 本次）：T02743 曾明确「不再用 git log 自动生成兜底」，理由是草稿会被当真说明发出去。
# 但一键发布的诉求是一条命令跑到底，缺说明就阻断等于把发布拆成两次人工；因此默认改为
# 「生成**明确标注的草稿** + WARN 日志」，并保留 -StrictNotes 恢复 T02743 的严格阻断。
function New-AutoReleaseNotes {
    param([string]$Version, [string]$Path)
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm'
    $lastTag = $null
    $range = '-30'
    $rangeDesc = '最近 30 条非合并提交'
    try {
        $lastTag = (& git -C $Root describe --tags --abbrev=0 2>$null)
        if ($LASTEXITCODE -eq 0 -and $lastTag) {
            $range = "$lastTag..HEAD"
            $rangeDesc = "$lastTag..HEAD"
        }
    } catch { }
    $commits = @()
    try { $commits = @(& git -C $Root log --no-merges --pretty=format:'- %s (%h)' $range 2>$null) } catch { }
    if ($commits.Count -eq 0) { $commits = @('- （无可用的 git 提交记录）') }

    $lines = @()
    $lines += "# Karpathy-Wiki v$Version"
    $lines += ""
    $lines += "> **自动生成草稿**：依据 git 提交记录（$rangeDesc），生成时间 $now。"
    $lines += "> 发布前请补齐「用户可见变化 / 破坏性变更 / 已知问题」；重发时覆盖本文件即可。"
    $lines += ""
    $lines += "## 变更"
    $lines += ""
    $lines += $commits
    $lines += ""
    $lines += "## 安装包"
    $lines += ""
    $lines += "- KarpathyWiki-Setup-v$Version.exe（Windows x64）"
    $lines += ""
    # 不写 BOM：publish-release.py 用 'utf-8' 读（不是 utf-8-sig），BOM 会原样进 GitHub Release 正文首字符；
    # 仓库里既有的 release-notes-*.md 也是无 BOM。PS 5.1 的 -Encoding UTF8 会加 BOM，故走 .NET 写入。
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, ($lines -join "`r`n"), $utf8NoBom)
}

# ---- GitHub Release 发布参数解析 ----
# 为什么抽成函数：自动打包会 bump package.json 的 patch 号，打包后必须重新解析一次，
# 否则仍拿「打包前的旧版本号」去找安装包（正是「未找到与版本 X 匹配的安装包」的成因之一）。
# 只读不落盘：dry-run 与真实执行共用同一套判定。
$doPublish = -not $SkipPublish
$autoBuilt = $false
$pyCands = @($p.python_candidates); if (-not $pyCands -or $pyCands.Count -eq 0) { $pyCands = @('python', 'python3', 'py') }
$versionSourcePath = Join-Path $Root $p.version_source

function Resolve-ReleaseContext {
    $ctx = [pscustomobject]@{
        PyExe = $null; Ver = $null; Asset = $null
        AssetIssue = $null; Notes = $null; NotesIssue = $null; NotesNote = $null
    }
    foreach ($cand in $pyCands) {
        $c = Get-Command $cand -ErrorAction SilentlyContinue
        if ($c) { $ctx.PyExe = $c.Source; break }
    }
    # 版本：package.json 单一真相源
    if (Test-Path $versionSourcePath) {
        try { $ctx.Ver = (Get-Content $versionSourcePath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
    }
    # 资产：必须与版本严格匹配；bump 后忘 build-exe 时阻断，绝不把旧包装进新 tag
    if ($ctx.Ver) {
        $ctx.Asset = Get-ChildItem (Join-Path $Root $p.release_asset_glob) -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*v$($ctx.Ver).*" -or $_.Name -like "*-$($ctx.Ver).*" } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $ctx.Asset) {
            $ctx.AssetIssue = "未找到与版本 $($ctx.Ver) 匹配的安装包: $($p.release_asset_glob)"
        }
    }
    # T02743 发布说明解析：显式 -ReleaseNotesFile 优先（真实发布时落地为约定文件名）；
    # 否则只认约定文件 release-notes-<VER>.md——缺失或仅剩 .auto.md 一律视为「说明未备好」，
    # 由步骤 0 决定「自动生成草稿」还是「阻断」（-StrictNotes）。
    if ($ctx.Ver) {
        $ctx.Notes = Join-Path $Root "$($p.release_notes_prefix)$($ctx.Ver).md"
        if ($ReleaseNotesFile) {
            if (-not (Test-Path $ReleaseNotesFile)) {
                $ctx.NotesIssue = "指定的 -ReleaseNotesFile 不存在: $ReleaseNotesFile"
            } else {
                $ctx.NotesNote = "已指定 -ReleaseNotesFile，发布时写入约定文件 $($ctx.Notes)"
            }
        } elseif (-not (Test-Path $ctx.Notes)) {
            $autoNotes = Join-Path $Root "$($p.release_notes_prefix)$($ctx.Ver).auto.md"
            if (Test-Path $autoNotes) {
                $ctx.NotesIssue = "只有 git log 兜底产物 $autoNotes，缺少正式说明 $($p.release_notes_prefix)$($ctx.Ver).md"
            } else {
                $ctx.NotesIssue = "正式 Release 说明缺失: $($p.release_notes_prefix)$($ctx.Ver).md"
            }
        }
    }
    return $ctx
}

$relCtx = $null
if ($doPublish) { $relCtx = Resolve-ReleaseContext }

Write-LogBanner -Title "$($Config.project.name) 一键发布 [会话: $($script:LogSessionId)]"
Write-Log "项目根: $Root" -Level INFO
Write-Log "Node: $NodeExe" -Level INFO
Write-Log "包管理器: $pkgManager" -Level INFO

# ============ 0) 自动打包（按需补齐安装包 / 发布说明）============
# 改造动因（本次报错）：bump 版本后直接跑一键发布，版本已变而安装包还是旧的（或压根没打），
# 旧脚本只会阻断并要求「请先运行 build-exe.bat」——等于把「打包 → 发布」拆成两次人工。
# 现在联动：缺包就自动调 build-exe.ps1，打完 **重新解析版本**（build-exe 会 bump patch 号，
# 不重新解析会继续拿旧版本号找包，永远找不到），再继续走门禁/部署/重启/发布。
if ($doPublish) {
    $buildReason = $null
    if ($RebuildPackage) { $buildReason = '已指定 -RebuildPackage（强制重打最新包）' }
    elseif ($relCtx.AssetIssue) { $buildReason = $relCtx.AssetIssue }

    if ($buildReason -and $NoAutoBuild) {
        Write-Log "按需打包已关闭（-NoAutoBuild）：$buildReason" -Level SKIP -Step "0/7"
    } elseif ($buildReason) {
        Write-Log "步骤 0/7 自动打包：$buildReason" -Level STEP -Step "0/7"
        Write-Log "将执行 scripts\build-exe.ps1（重建 harness/SPA + esbuild + pkg + Inno，并 bump patch 版本号）" -Level INFO -Step "0/7"
        if ($DryRun) {
            Write-Log "[DRY-RUN] 自动打包：powershell -File scripts\build-exe.ps1（版本号会被 bump，故后续步骤按新版本找包）" -Level WARN -Step "0/7"
        } else {
            $verBefore = $relCtx.Ver
            $buildExePs1 = Join-Path $PSScriptRoot 'build-exe.ps1'
            if (-not (Test-Path $buildExePs1)) {
                Write-Log "未找到构建脚本: $buildExePs1" -Level ERROR -Step "0/7"
                exit 1
            }
            # 走子进程而不是 .bat：build-exe.bat 结尾有 pause，被脚本调用会挂住；
            # 子进程也让 build-exe 的 Set-Location / PATH 变更 / throw 不影响本脚本。
            & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $buildExePs1
            if ($LASTEXITCODE -ne 0) {
                Write-Log "自动打包失败（exit $LASTEXITCODE），见上方 build-exe 输出" -Level ERROR -Step "0/7"
                Write-Log "常见原因：release 目录空间不足（可清 release/builds 与最旧 public_live_*）、Inno Setup 不可用、gate 未通过" -Level ERROR -Step "0/7"
                Write-Log "也可先单独跑 scripts\build-exe.bat 排查，成功后再重跑本脚本" -Level ERROR -Step "0/7"
                exit 1
            }
            $autoBuilt = $true
            $relCtx = Resolve-ReleaseContext
            if ($verBefore -and $relCtx.Ver -and $verBefore -ne $relCtx.Ver) {
                Write-Log "版本已 bump：$verBefore -> $($relCtx.Ver)（后续按新版本发布）" -Level OK -Step "0/7"
            }
            if ($relCtx.Asset) {
                Write-Log "安装包就绪: $($relCtx.Asset.Name)（$([math]::Round($relCtx.Asset.Length / 1MB, 1)) MB）" -Level OK -Step "0/7"
            } else {
                Write-Log "打包完成但仍未找到匹配当前版本 $($relCtx.Ver) 的安装包" -Level ERROR -Step "0/7"
                $iscc = Find-InnoCompiler
                if (-not $iscc) {
                    Write-Log "真因：Inno Setup 未安装——build-exe 会「跳过安装包制作」但仍以 0 退出，因此根本不产出 exe" -Level ERROR -Step "0/7"
                    Write-Log "装好后重跑：winget install JRSoftware.InnoSetup  或 https://jrsoftware.org/isdl.php" -Level ERROR -Step "0/7"
                } else {
                    Write-Log "Inno Setup 可用（$iscc），问题在 build-exe [8/8] 编译阶段：检查其输出与 release\installer 目录" -Level ERROR -Step "0/7"
                }
            }
        }
    }

    # 发布说明：缺失则生成明确标注的草稿（-StrictNotes 时保持 T02743 的阻断口径）。
    # 前置条件：安装包已就绪——连包都还没打出来就先写说明，只会留下一份「发不出去版本」的孤儿草稿。
    if ($relCtx.NotesIssue -and -not $relCtx.AssetIssue -and -not $StrictNotes -and -not $ReleaseNotesFile -and -not $DryRun) {
        Write-Log "发布说明缺失，自动生成草稿: $($relCtx.Notes)" -Level WARN -Step "0/7"
        try {
            New-AutoReleaseNotes -Version $relCtx.Ver -Path $relCtx.Notes
            $relCtx = Resolve-ReleaseContext
            Write-Log "草稿已生成（内容来自 git 提交记录）；如需正式说明，覆盖该文件后重跑，或用 -ReleaseNotesFile 指定" -Level WARN -Step "0/7"
        } catch {
            Write-Log "草稿生成失败: $_" -Level ERROR -Step "0/7"
        }
    }

    # 发布前置校验：缺件必须在构建/部署/重启之前阻断，避免服务已重启才发现发不出去
    $relIssues = @()
    if (-not $relCtx.PyExe) { $relIssues += "未找到 Python（候选: $($pyCands -join ' / ') 均不可用）" }
    if (-not $relCtx.Ver) { $relIssues += "无法推导版本号（检查 $($p.version_source) 的 version 字段）" }
    if ($relCtx.AssetIssue) {
        $assetHint = if ($autoBuilt) { '（自动打包未产出匹配版本，见上方 build-exe 输出）' }
            elseif ($NoAutoBuild) { '（-NoAutoBuild 已禁用自动打包；去掉该开关即可自动打）' }
            else { '' }
        $relIssues += "$($relCtx.AssetIssue)$assetHint"
    }
    if ($relCtx.NotesIssue) { $relIssues += "$($relCtx.NotesIssue)（去掉 -StrictNotes 可自动生成草稿）" }
    if ($relIssues.Count -gt 0) {
        if ($DryRun) {
            foreach ($issue in $relIssues) { Write-Log "[DRY-RUN] 发布前置条件不满足: $issue" -Level WARN }
            Write-Log "[DRY-RUN] 正式发布会自动补齐（打包 + 说明草稿）后继续；只想部署可加 -SkipPublish" -Level WARN
        } else {
            foreach ($issue in $relIssues) { Write-Log "发布阻断：$issue" -Level ERROR }
            Write-Log "补齐后重跑；只想部署 SPA 而不发 Release 时加 -SkipPublish" -Level ERROR
            exit 1
        }
    }
}

if ($DryRun) {
    Write-Log "[DRY-RUN] 仅打印将执行的命令，不实际构建/部署/重启/发布" -Level WARN
    if ($doPublish -and $relCtx.AssetIssue) {
        Write-Log "0) 自动打包 : powershell -File scripts\build-exe.ps1（当前版本 $($relCtx.Ver) 无匹配安装包）" -Level INFO
    } elseif (-not $doPublish) {
        Write-Log "0) 自动打包 : 跳过（-SkipPublish，不发 Release 无需安装包）" -Level INFO
    } else {
        Write-Log "0) 自动打包 : 跳过（安装包已就绪：$($relCtx.Asset.Name)）" -Level INFO
    }
    Write-Log "1) 安装依赖 : $pkgManager $(Join-Args $installArgs)" -Level INFO
    Write-Log "2) 发布门禁 : pnpm --filter @karpathy-wiki/api run gate -> @karpathy-wiki/web run gate" -Level INFO
    Write-Log "3) 构建前端 : $pkgManager $(Join-Args $buildArgs)" -Level INFO
    Write-Log "4) 部署     : $NodeExe $($p.deploy_script) $deploySrc" -Level INFO
    $dt = Resolve-Path $deployTargetDir -ErrorAction SilentlyContinue
    Write-Log "   部署目标 : $dt (每次新建 public_live_<ts>，由 index.ts 自动选用最新)" -Level INFO
    Write-Log "5) 重启生产 : 停止端口 $apiPort -> $pkgManager $(Join-Args $prodStartArgs) (日志 $prodLog)" -Level INFO
    Write-Log "6) 健康检查 : $healthUrl / $spaUrl" -Level INFO
    if ($doPublish) {
        if ($relCtx.PyExe -and $relCtx.Asset -and $relCtx.Ver) {
            Write-Log "7) 发布 Release: $($relCtx.PyExe) publish-release.py $($relCtx.Asset.Name) (GH_TAG=$($relCtx.Ver) GH_DRY_RUN=1)" -Level INFO
        } else {
            Write-Log "7) 发布 Release: 前置条件不满足（正式发布会自动打包补齐；详见上方 WARN）" -Level WARN
        }
        if ($relCtx.NotesNote) {
            Write-Log "   发布说明 : $($relCtx.NotesNote)" -Level INFO
        } elseif ($relCtx.Notes) {
            Write-Log "   发布说明 : $($relCtx.Notes)$(if (-not (Test-Path $relCtx.Notes)) { '（缺失，正式发布会自动生成草稿）' })" -Level INFO
        }
    } else {
        Write-Log "7) 发布 Release: 未启用（-SkipPublish）" -Level SKIP
    }
    exit 0
}

# ============ 1) 安装依赖 ============
Write-Log "步骤 1/7 安装依赖..." -Level STEP -Step "1/7"
if ($SkipInstall) {
    Write-Log "跳过安装（-SkipInstall）" -Level SKIP -Step "1/7"
} else {
    & $pkgManager @installArgs
    if ($LASTEXITCODE -ne 0) { Write-Log "依赖安装失败" -Level ERROR -Step "1/7"; exit 1 }
    Write-Log "依赖安装完成" -Level OK -Step "1/7"
}

# ============ 2) 发布门禁（T04910）============
# 把双侧 pnpm gate 接入发布校验：串行执行（先 api 后 web），避免 api 性能用例与前端全量并发导致假红；
# 任一侧失败即 exit 1（失败即停），不让带类型错误/测试失败的产物进入部署与重启。
Write-Log "步骤 2/7 发布门禁（pnpm gate）..." -Level STEP -Step "2/7"
if ($SkipGate) {
    Write-Log "跳过发布门禁（-SkipGate）" -Level SKIP -Step "2/7"
} elseif ($autoBuilt) {
    # 步骤 0 的 build-exe 内部已串行跑过双侧 gate 且失败即停，这里重复跑等于白等 ~7 分钟
    Write-Log "跳过发布门禁：自动打包（步骤 0）已跑过双侧 gate 且通过" -Level SKIP -Step "2/7"
} else {
    if ($pkgManager -notmatch 'pnpm') {
        Write-Log "发布门禁依赖 pnpm --filter 过滤 workspace 包；当前包管理器为 $pkgManager（T04910）" -Level ERROR -Step "2/7"
        exit 1
    }
    & $pkgManager --filter @karpathy-wiki/api run gate
    if ($LASTEXITCODE -ne 0) { Write-Log "api gate 未通过，发布中止" -Level ERROR -Step "2/7"; exit 1 }
    Write-Log "api gate 通过" -Level OK -Step "2/7"
    & $pkgManager --filter @karpathy-wiki/web run gate
    if ($LASTEXITCODE -ne 0) { Write-Log "web gate 未通过，发布中止" -Level ERROR -Step "2/7"; exit 1 }
    Write-Log "web gate 通过" -Level OK -Step "2/7"
}

# ============ 3) 构建前端 SPA ============
Write-Log "步骤 3/7 构建前端 SPA..." -Level STEP -Step "3/7"
if ($SkipBuild) {
    Write-Log "跳过构建（-SkipBuild）" -Level SKIP -Step "3/7"
} elseif ($autoBuilt) {
    # build-exe 的 [3/8] 已把 SPA 构建到 $deploySrc（release/spa/public），且安装包里用的是同一份产物
    Write-Log "跳过 SPA 构建：自动打包（步骤 0）已构建到 $deploySrc" -Level SKIP -Step "3/7"
} else {
    $buildProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "$pkgManager $(Join-Args $buildArgs) > `"$buildLog`" 2>&1" -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
    if ($buildProc.ExitCode -ne 0) {
        Write-Log "前端构建失败，日志尾部:" -Level ERROR -Step "3/7"
        if (Test-Path $buildLog) { Get-Content $buildLog -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } }
        exit 1
    }
    Write-Log "前端构建完成 -> $deploySrc" -Level OK -Step "3/7"
}

# ============ 4) 部署到 live ============
Write-Log "步骤 4/7 部署到 live 目录..." -Level STEP -Step "4/7"
if ($SkipDeploy) {
    Write-Log "跳过部署（-SkipDeploy）" -Level SKIP -Step "4/7"
} else {
    if (-not (Test-Path (Join-Path (Join-Path $Root $deploySrc) 'index.html'))) {
        Write-Log "未找到构建产物 index.html: $deploySrc（请先构建）" -Level ERROR -Step "4/7"
        exit 1
    }
    & $NodeExe $deployScript $deploySrc
    if ($LASTEXITCODE -ne 0) { Write-Log "部署失败" -Level ERROR -Step "4/7"; exit 1 }
    Write-Log "部署完成，已生成 public_live_<ts>" -Level OK -Step "4/7"
}

# ============ 5) 重启生产服务 ============
Write-Log "步骤 5/7 重启生产服务 (端口 $apiPort)..." -Level STEP -Step "5/7"
if ($SkipRestart) {
    Write-Log "跳过重启（-SkipRestart）" -Level SKIP -Step "5/7"
} else {
    # 停止端口上的旧进程（dev api / 旧 prod 都监听 3000）
    $oldPids = Get-PidOnPort -Port $apiPort
    foreach ($procId in $oldPids) {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
        Write-Log "已停止旧进程 PID $procId" -Level OK -Step "5/7"
    }
    if ($oldPids.Count -eq 0) { Write-Log "端口 $apiPort 无旧进程" -Level SKIP -Step "5/7" }
    Start-Sleep -Seconds 1

    # 后台启动生产服务（单端口：API + 内置 SPA）
    Start-Process cmd.exe -ArgumentList "/c", "$pkgManager $(Join-Args $prodStartArgs) > `"$prodLog`" 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
    Write-Log "生产服务已启动（日志 $prodLog）" -Level INFO -Step "5/7"

    $ready = Wait-PortReady -Port $apiPort -MaxTries ([int]$p.wait_max_tries) -IntervalSeconds ([int]$p.ping_interval_seconds)
    if (-not $ready) {
        Write-Log "端口 $apiPort 在超时内未就绪" -Level ERROR -Step "5/7"
        if (Test-Path $prodLog) { Get-Content $prodLog -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } }
        exit 1
    }
    $newPids = Get-PidOnPort -Port $apiPort
    Write-Log "生产服务已就绪 (PID: $($newPids -join ', '))" -Level OK -Step "5/7"
}

# ============ 6) 健康检查 ============
Write-Log "步骤 6/7 健康检查..." -Level STEP -Step "6/7"
try {
    $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10 -ErrorAction Stop
    if ($h.ok) { Write-Log "API 健康: $healthUrl -> ok" -Level OK -Step "6/7" } else { Write-Log "API 健康检查返回非 ok" -Level WARN -Step "6/7" }
} catch {
    Write-Log "API 健康检查失败: $_" -Level WARN -Step "6/7"
}
try {
    $r = Invoke-WebRequest -Uri $spaUrl -TimeoutSec 10 -ErrorAction Stop
    if ($r.Content -match '<!DOCTYPE|<title>|index\.html') {
        Write-Log "SPA 可访问: $spaUrl ($( $r.StatusCode ))" -Level OK -Step "6/7"
    } else {
        Write-Log "SPA 返回内容异常 ($( $r.StatusCode ))" -Level WARN -Step "6/7"
    }
} catch {
    Write-Log "SPA 访问失败: $_" -Level WARN -Step "6/7"
}

# ============ 7) 发布 GitHub Release（默认发布，-SkipPublish 关闭）============
if ($doPublish) {
    Write-Log "步骤 7/7 发布 GitHub Release..." -Level STEP -Step "7/7"
    # 前置条件已在启动前校验通过；显式指定说明文件时在此落地为约定文件名
    if ($ReleaseNotesFile) {
        Copy-Item -Path $ReleaseNotesFile -Destination $relCtx.Notes -Force
        Write-Log "说明文件已落地: $($relCtx.Notes)（来自 -ReleaseNotesFile）" -Level INFO -Step "7/7"
    }

    $env:GH_TAG = $relCtx.Ver
    Write-Log "Python: $($relCtx.PyExe)" -Level INFO -Step "7/7"
    Write-Log "资产  : $($relCtx.Asset.FullName)" -Level INFO -Step "7/7"
    Write-Log "版本  : $($relCtx.Ver)  说明: $($relCtx.Notes)" -Level INFO -Step "7/7"
    & $relCtx.PyExe (Join-Path $PSScriptRoot 'publish-release.py') $relCtx.Asset.FullName $relCtx.Notes $relCtx.Asset.Name
    if ($LASTEXITCODE -ne 0) { Write-Log "GitHub Release 发布失败（检查 .env 的 GH_TOKEN 或 git 凭据库 github.com 凭证）" -Level ERROR -Step "7/7"; exit 1 }
    Write-Log "GitHub Release 发布完成 (tag=$($relCtx.Ver))" -Level OK -Step "7/7"
} else {
    Write-Log "步骤 7/7 跳过 GitHub Release 发布（-SkipPublish）" -Level SKIP -Step "7/7"
}

Write-LogBanner -Title "$($Config.project.name) 一键发布完成 [会话: $($script:LogSessionId)]"
Write-Log "访问地址: $spaUrl" -Level INFO
Write-Log "API 健康: $healthUrl" -Level INFO
Write-Log "生产日志: $prodLog" -Level INFO
Write-Log "停止服务: 双击 scripts\stop-service.bat" -Level INFO
exit 0
