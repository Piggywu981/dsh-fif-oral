# 把 dsh-fif-oral 挂进 DSH profile。
# 不跑 pnpm install：DSH 运行时占用 profile/node_modules，pnpm 会因文件锁失败。
# 做法是 node_modules junction + profile 的 cordis.patch.yml 插入一条带标记的 patch。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
param(
  [string]$ProfileRoot = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
if (-not $ProfileRoot) { $ProfileRoot = Join-Path $env:USERPROFILE ".dsh\profiles\desktop" }
if (-not (Test-Path $ProfileRoot)) { throw "找不到 profile 目录：$ProfileRoot" }

$linkPath = Join-Path $ProfileRoot "node_modules\dsh-fif-oral"
$patchPath = Join-Path $ProfileRoot "cordis.patch.yml"
$beginMark = "# >>> dsh-fif-oral"
$endMark = "# <<< dsh-fif-oral"

function Remove-MarkedBlock([string[]]$lines) {
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in $lines) {
    if ($line.Trim() -eq $beginMark) { $skip = $true; continue }
    if ($line.Trim() -eq $endMark) { $skip = $false; continue }
    if (-not $skip) { $out.Add($line) }
  }
  return $out.ToArray()
}

Write-Host "插件目录：$pluginRoot"
Write-Host "profile  ：$ProfileRoot"

if ($Uninstall) {
  if (Test-Path $linkPath) { (Get-Item $linkPath).Delete(); Write-Host "已删除 junction" }
  if (Test-Path $patchPath) {
    $lines = [System.IO.File]::ReadAllLines($patchPath, [System.Text.Encoding]::UTF8)
    $kept = Remove-MarkedBlock $lines
    [System.IO.File]::WriteAllText($patchPath, (($kept -join "`n").TrimEnd() + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已从 cordis.patch.yml 移除插件条目"
  }
  Write-Host "`n卸载完成，重启 DSH 生效。" -ForegroundColor Yellow
  return
}

# 1) junction
if (Test-Path $linkPath) {
  Write-Host "junction 已存在，跳过"
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $pluginRoot | Out-Null
  Write-Host "已创建 junction：node_modules\dsh-fif-oral -> $pluginRoot"
}

# 2) cordis.patch.yml 标记块（幂等）
if (-not (Test-Path $patchPath)) { throw "找不到 $patchPath" }
$raw = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
$lines = [System.IO.File]::ReadAllLines($patchPath, [System.Text.Encoding]::UTF8)
$cleaned = Remove-MarkedBlock $lines

$block = @"
$beginMark
- insert:
    - id: fif-oral
      name: dsh-fif-oral
      config:
        browser:
          channel: auto
          headless: false
        tts:
          engine: edge
          voice: en-US-AriaNeural
        targetScore: 60
$endMark
"@

# 首次改动前备份
$bak = "$patchPath.bak-fif-oral"
if (-not (Test-Path $bak)) { Copy-Item $patchPath $bak -Force; Write-Host "已备份 cordis.patch.yml" }

$body = ($cleaned -join "`n").TrimEnd() + "`n`n" + $block.Replace("`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText($patchPath, $body, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入 cordis.patch.yml 插件条目"

Write-Host "`n安装完成。重启 DSH 后在对话里说 fif_doctor 检查依赖。" -ForegroundColor Green
