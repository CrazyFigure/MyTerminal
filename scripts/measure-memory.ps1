# MyTerminal 内存采样脚本
# 启动指定 exe，按 10/30/60 秒采样 MyTerminal 及其真实 WebView2 子进程，
# 输出 Working Set / Private Bytes / 线程数 / 进程类型，支持软件渲染与硬件加速自动对照。
# 用法示例：
#   pwsh -File scripts/measure-memory.ps1 -ExePath "C:\Path\MyTerminal.exe"
#   pwsh -File scripts/measure-memory.ps1 -ExePath "C:\Path\MyTerminal.exe" -SoftwareRendering
#   pwsh -File scripts/measure-memory.ps1 -ExePath "C:\Path\MyTerminal.exe" -Compare

param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,
    # 采样时刻（秒），默认覆盖启动、稳定、冷却三个阶段。
    [int[]]$SampleSeconds = @(10, 30, 60),
    # 仅软件渲染兼容模式（关闭 WebView2 硬件加速）单次采样；LowMemory 作为旧参数别名继续兼容。
    [Alias('LowMemory')]
    [switch]$SoftwareRendering,
    # 同时跑硬件加速与软件渲染模式并打印对照。
    [switch]$Compare,
    # 采样结果输出目录，默认写到仓库 .memory-samples。
    [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# 统一 UTF-8，避免中文进程名/路径在 JSON/CSV 中乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path $ExePath)) {
    Write-Error "未找到可执行文件：$ExePath"
}
$ExePath = (Resolve-Path $ExePath).Path

if (-not $OutDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
    $OutDir = Join-Path $repoRoot '.memory-samples'
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

# 根据可执行文件名与命令行猜测 WebView2 子进程类型，便于逐进程定位内存大头。
function Get-ProcessRole {
    param([System.Diagnostics.Process]$Process, [string]$CommandLine)

    if ($Process.Id -eq $script:RootPid) {
        return 'main'
    }
    if (-not $CommandLine) {
        return 'webview2'
    }
    if ($CommandLine -match '--type=gpu-process') { return 'webview2-gpu' }
    if ($CommandLine -match '--type=renderer') { return 'webview2-renderer' }
    if ($CommandLine -match '--type=utility.*network') { return 'webview2-network' }
    if ($CommandLine -match '--type=utility.*storage') { return 'webview2-storage' }
    if ($CommandLine -match '--type=utility') { return 'webview2-utility' }
    if ($CommandLine -match '--type=crashpad') { return 'webview2-crashpad' }
    if ($CommandLine -match 'msedgewebview2') { return 'webview2-browser' }
    return 'webview2'
}

# 收集根进程 PID 全集：根进程本身 + 其所有 msedgewebview2 后代。
# 用 ParentProcessId 从进程快照做闭包展开，避免 PID 复用把无关进程算进来。
function Get-ProcessTreePids {
    param([int]$RootPid)

    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $byParent = @{}
    foreach ($proc in $all) {
        $parent = [int]$proc.ParentProcessId
        if (-not $byParent.ContainsKey($parent)) {
            $byParent[$parent] = New-Object System.Collections.Generic.List[object]
        }
        $byParent[$parent].Add($proc)
    }

    $result = @{}
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if ($result.ContainsKey($current)) { continue }
        $result[$current] = $true
        if ($byParent.ContainsKey($current)) {
            foreach ($child in $byParent[$current]) {
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }

    # 返回 PID -> CommandLine 映射，供角色识别使用。
    $map = @{}
    foreach ($proc in $all) {
        if ($result.ContainsKey([int]$proc.ProcessId)) {
            $map[[int]$proc.ProcessId] = $proc.CommandLine
        }
    }
    return $map
}

# 对当前进程树做一次采样，返回逐进程明细与总计。
function Measure-ProcessTree {
    param([int]$RootPid, [int]$ElapsedSec, [string]$Mode)

    $pidMap = Get-ProcessTreePids -RootPid $RootPid
    $rows = New-Object System.Collections.Generic.List[object]
    $totalWorkingSet = 0L
    $totalPrivate = 0L
    $totalThreads = 0

    foreach ($procPid in $pidMap.Keys) {
        $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $role = Get-ProcessRole -Process $proc -CommandLine $pidMap[$procPid]

        # WorkingSet64 = 物理驻留；PrivateMemorySize64 ≈ 提交的独占内存，用于判断独占成本。
        $ws = [int64]$proc.WorkingSet64
        $priv = [int64]$proc.PrivateMemorySize64
        $threads = $proc.Threads.Count

        $totalWorkingSet += $ws
        $totalPrivate += $priv
        $totalThreads += $threads

        $rows.Add([pscustomobject]@{
            mode          = $Mode
            elapsedSec    = $ElapsedSec
            pid           = $procPid
            role          = $role
            workingSetMB  = [math]::Round($ws / 1MB, 1)
            privateMB     = [math]::Round($priv / 1MB, 1)
            threads       = $threads
        })
    }

    $summary = [pscustomobject]@{
        mode              = $Mode
        elapsedSec        = $ElapsedSec
        processCount      = $rows.Count
        totalWorkingSetMB = [math]::Round($totalWorkingSet / 1MB, 1)
        totalPrivateMB    = [math]::Round($totalPrivate / 1MB, 1)
        totalThreads      = $totalThreads
    }

    return [pscustomobject]@{ Rows = $rows; Summary = $summary }
}

# 启动一次应用，按时间点采样后停止自己启动的全部进程。
function Invoke-Measurement {
    param([string]$Mode, [bool]$UseSoftwareRendering)

    Write-Host "==== 模式：$Mode ===="
    # 软件渲染通过命令行主参数 --software-rendering 触发；不修改系统或用户持久化设置。
    $procArgs = @()
    if ($UseSoftwareRendering) {
        $procArgs += '--software-rendering'
    }

    $started = if ($procArgs.Count -gt 0) {
        Start-Process -FilePath $ExePath -ArgumentList $procArgs -PassThru
    } else {
        Start-Process -FilePath $ExePath -PassThru
    }
    $script:RootPid = $started.Id

    $allRows = New-Object System.Collections.Generic.List[object]
    $summaries = New-Object System.Collections.Generic.List[object]
    try {
        $prev = 0
        foreach ($mark in ($SampleSeconds | Sort-Object)) {
            $wait = $mark - $prev
            if ($wait -gt 0) { Start-Sleep -Seconds $wait }
            $prev = $mark

            $sample = Measure-ProcessTree -RootPid $script:RootPid -ElapsedSec $mark -Mode $Mode
            foreach ($row in $sample.Rows) { $allRows.Add($row) }
            $summaries.Add($sample.Summary)
            Write-Host ("  {0,3}s | 进程 {1,2} | 私有 {2,7} MB | 工作集 {3,7} MB | 线程 {4}" -f `
                $mark, $sample.Summary.processCount, $sample.Summary.totalPrivateMB, `
                $sample.Summary.totalWorkingSetMB, $sample.Summary.totalThreads)
        }
    }
    finally {
        # 脚本必须停止自己启动的全部进程树，避免残留后台进程干扰后续采样或系统内存。
        $treePids = Get-ProcessTreePids -RootPid $script:RootPid
        foreach ($procPid in $treePids.Keys) {
            Stop-Process -Id $procPid -Force -ErrorAction SilentlyContinue
        }
    }

    return [pscustomobject]@{ Rows = $allRows; Summaries = $summaries }
}

$runs = @()
if ($Compare) {
    $runs += ,@('hardware-accelerated', $false)
    $runs += ,@('software-rendering', $true)
} elseif ($SoftwareRendering) {
    $runs += ,@('software-rendering', $true)
} else {
    $runs += ,@('hardware-accelerated', $false)
}

$allRows = New-Object System.Collections.Generic.List[object]
$allSummaries = New-Object System.Collections.Generic.List[object]
foreach ($run in $runs) {
    $result = Invoke-Measurement -Mode $run[0] -UseSoftwareRendering $run[1]
    foreach ($row in $result.Rows) { $allRows.Add($row) }
    foreach ($summary in $result.Summaries) { $allSummaries.Add($summary) }
}

# 输出 JSON + CSV，便于版本间比较（文件名用固定前缀，方便按修改时间归档）。
$jsonPath = Join-Path $OutDir 'memory-sample.json'
$csvPath = Join-Path $OutDir 'memory-sample.csv'
$allRows | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8
$allRows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

Write-Host ''
Write-Host '==== 汇总 ===='
$allSummaries | Format-Table -AutoSize

if ($Compare) {
    $hardware = $allSummaries | Where-Object { $_.mode -eq 'hardware-accelerated' } | Sort-Object elapsedSec | Select-Object -Last 1
    $software = $allSummaries | Where-Object { $_.mode -eq 'software-rendering' } | Sort-Object elapsedSec | Select-Object -Last 1
    if ($hardware -and $software) {
        # 正数表示软件渲染占用更多，负数表示软件渲染占用更少；保持中性表述，不预设哪种模式必然更省内存。
        $delta = [math]::Round($software.totalPrivateMB - $hardware.totalPrivateMB, 1)
        $pct = if ($hardware.totalPrivateMB -gt 0) { [math]::Round($delta / $hardware.totalPrivateMB * 100, 1) } else { 0 }
        Write-Host ("软件渲染相对硬件加速的私有内存差值：{0} MB（{1}%）" -f $delta, $pct)
    }
}

Write-Host "明细已写入：$jsonPath"
Write-Host "CSV 已写入：$csvPath"
