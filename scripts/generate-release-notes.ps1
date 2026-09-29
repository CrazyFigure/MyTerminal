# 生成 GitHub Release 与应用内更新弹窗使用的“更新内容”。
# 规则见 AGENTS.md「发版规范」：普通提交读取标题；发版提交（chore/docs(release)）读取正文中的
# “- type(scope): 描述”条目。只保留用户可感知的 feat/fix/perf/refactor/style，其余类型与版本同步条目忽略。
param(
  # 本次发布的提交引用，CI 中为当前 tag 所在提交。
  [string]$Ref = 'HEAD',
  # 上一个 tag；为空时自动查找 $Ref 之前最近的可达 tag。
  [string]$PreviousTag = ''
)

$ErrorActionPreference = 'Stop'
# 发布说明含中文，统一使用 UTF-8 读写 git 输出，避免 Windows 默认代码页乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $PreviousTag) {
  $previousTagOutput = git describe --tags --abbrev=0 "$Ref^" 2>$null
  if ($LASTEXITCODE -eq 0) {
    $PreviousTag = $previousTagOutput
  }
}
$range = if ($PreviousTag) { "$PreviousTag..$Ref" } else { $Ref }

$conventionalPattern = '^(?<type>feat|fix|perf|refactor|style|docs|chore|test|build|ci)(\((?<scope>[^)]+)\))?!?:\s*(?<text>.+)$'
$releaseSubjectPattern = '^(docs|chore)\(release\):'

$groups = [ordered]@{
  '新增' = [System.Collections.Generic.List[string]]::new()
  '修复' = [System.Collections.Generic.List[string]]::new()
  '优化' = [System.Collections.Generic.List[string]]::new()
}

# 把一条 Conventional Commit 文本归入分组；用户不可感知的类型和版本同步、star history 等维护项直接丢弃。
function Add-ReleaseItem([string]$line) {
  $trimmed = $line.Trim()
  if ($trimmed -notmatch $conventionalPattern) {
    return
  }
  $type = $Matches['type']
  $scope = $Matches['scope']
  $text = $Matches['text'].Trim()
  if ($scope -eq 'version' -or $text -match '(?i)update star history') {
    return
  }
  switch ($type) {
    'feat' { $target = '新增' }
    'fix' { $target = '修复' }
    { $_ -in @('perf', 'refactor', 'style') } { $target = '优化' }
    default { return }
  }
  # 多个提交可能重复描述同一改动，按文本去重，保持首次出现顺序。
  if (-not $groups[$target].Contains($text)) {
    $groups[$target].Add($text)
  }
}

# 以记录分隔符拆分提交，git log 默认新到旧，这里反转为旧到新，使条目顺序与开发顺序一致。
$rawLog = (git log --reverse --format='%s%x1f%b%x1e' $range) -join "`n"
foreach ($record in ($rawLog -split [char]0x1e)) {
  if ([string]::IsNullOrWhiteSpace($record)) {
    continue
  }
  $parts = $record -split [char]0x1f, 2
  $subject = $parts[0].Trim()
  $body = if ($parts.Count -gt 1) { $parts[1] } else { '' }

  if ($subject -match $releaseSubjectPattern) {
    # 发版提交的正文逐行列出本次改动，每行形如“- feat(scope): 描述”。
    foreach ($bodyLine in ($body -split "`r?`n")) {
      Add-ReleaseItem ($bodyLine -replace '^\s*[-*]\s*', '')
    }
    continue
  }
  Add-ReleaseItem $subject
}

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($heading in $groups.Keys) {
  $lines.Add("${heading}：")
  if ($groups[$heading].Count -gt 0) {
    foreach ($item in $groups[$heading]) {
      $lines.Add("- $item")
    }
  } else {
    $lines.Add("- 本次暂无${heading}项。")
  }
  $lines.Add('')
}

($lines -join [Environment]::NewLine).TrimEnd()
