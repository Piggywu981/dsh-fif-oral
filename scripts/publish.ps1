# 发布 dsh-fif-oral 到 npm。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1            # 预检 + 发布
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -DryRun     # 只预检
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Tag        # 发布后打 git tag
param(
  [switch]$DryRun,
  [switch]$Tag,
  [string]$Otp = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $pkg = Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $name = $pkg.name
  $version = $pkg.version
  Write-Host "包：$name@$version" -ForegroundColor Cyan

  # 1) 登录状态
  $who = (& npm whoami 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $who -or $who -match '^npm error') {
    Write-Host "`n未登录 npm（当前 registry：$(& npm config get registry)）" -ForegroundColor Yellow
    Write-Host "先执行：npm login   （会开浏览器，登录后回来重跑本脚本）" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "npm 账号：$who"

  # 2) 版本是否已存在
  $exists = (& npm view "$name@$version" version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -eq 0 -and $exists -and $exists -notmatch '^npm error') {
    Write-Host "`n$name@$version 已经发布过了，先把 package.json 的 version 改掉。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "版本号可用"

  # 3) 隐私检查：确认打包内容里没有 data / 登录态
  Write-Host "`n--- 打包内容 ---"
  $packOut = & npm pack --dry-run 2>&1 | Out-String
  $files = ($packOut -split "`r?`n") | Where-Object { $_ -match '^npm notice \d' }
  $files | ForEach-Object { Write-Host ($_ -replace '^npm notice ', '  ') }
  $bad = $files | Where-Object { $_ -match 'data/|profile|answers\.json|node_modules|\.tgz|test/' }
  if ($bad) {
    Write-Host "`n包里有不该发布的内容：" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
  Write-Host "内容检查通过（无 data/ 无登录态）"

  if ($DryRun) {
    Write-Host "`nDryRun 结束，未发布。" -ForegroundColor Green
    return
  }

  # 4) 发布
  $npmArgs = @("publish", "--access", "public")
  if ($Otp) { $npmArgs += @("--otp", $Otp) }
  Write-Host "`n执行 npm $($npmArgs -join ' ') ..." -ForegroundColor Cyan
  $out = (& npm @npmArgs 2>&1 | Out-String)
  $ok = $LASTEXITCODE -eq 0
  Write-Host $out
  if (-not $ok) {
    if ($out -match 'EOTP|one-time password|auth/cli') {
      Write-Host "`n这个 npm 账号的 two-factor 是 auth-and-writes，每次发布都要一次性密码。" -ForegroundColor Yellow
      Write-Host "而 npm 在非交互管道里会把授权链接脱敏成 ***，所以要开一个真终端：" -ForegroundColor Yellow
      Write-Host "  Start-Process cmd -ArgumentList '/k npm publish --access public'" -ForegroundColor Cyan
      Write-Host "  → 新窗口里 npm 会直接问 OTP，输入验证器 6 位码回车即可。" -ForegroundColor Yellow
      Write-Host "也可以在 PowerShell 里直接带码：" -ForegroundColor Yellow
      Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Otp 123456" -ForegroundColor Cyan
      exit 2
    }
    throw "npm publish 失败（exit $LASTEXITCODE）"
  }

  # 5) 可选 tag
  if ($Tag) {
    & git rev-parse --git-dir 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      & git tag "v$version"
      & git push origin "v$version"
      Write-Host "已打 tag v$version 并推送" -ForegroundColor Green
    } else {
      Write-Host "当前不是 git 仓库，跳过 tag" -ForegroundColor Yellow
    }
  }

  Write-Host "`n发布完成：https://www.npmjs.com/package/$name" -ForegroundColor Green
  Write-Host "别人安装：dsh plugin --profile desktop add $name" -ForegroundColor Green
} finally {
  Pop-Location
}
