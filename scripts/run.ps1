<#
.SYNOPSIS
  Amazon Listing Check 一条龙（原生 Windows）：启动无头 Chrome/Edge(带扩展) → 驱动抓取 → xlsx。

.DESCRIPTION
  与 scripts/run.sh 等价，只是为 Windows 重写了浏览器发现、profile 路径和进程管理：
  正浏览器的二进制、%LOCALAPPDATA% 下的 profile、按 profile 精确结束残留进程。
  drive.mjs / cdp.mjs / check-login.mjs 本身就跨平台，直接复用。

.EXAMPLE
  .\scripts\run.ps1 "B09B8V1LZ3,B00FLYWNYQ"
  .\scripts\run.ps1 "B0XXXXXXXX" -WithReviews -Chunk 8 -MaxImageEdge 512
  .\scripts\run.ps1 "B0XXXXXXXX" -CheckLogin
  .\scripts\run.ps1 "B0XXXXXXXX" -Login      # 打印人工登录指引

.NOTES
  退出码: 0=至少1个ASIN成功  1=链路错误  2=全部ASIN失败  3=差评模式但未登录
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Asins,
  [int]$Zip = 10010,
  [int]$Delay = 1200,
  [string]$MaxImageEdge = "",
  [switch]$WithReviews,
  [int]$Retry = 1,
  [int]$Chunk = 0,
  [int]$Port = 19222,
  [int]$TimeoutMin = 25,
  [string]$Browser = "",
  [switch]$FreshProfile,
  [switch]$CheckLogin,
  [switch]$Login
)

$ErrorActionPreference = "Stop"
# 控制台默认是 OEM 代码页，中文输出从别的工具（含 bash）看会是乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ScriptDir = $PSScriptRoot
$ExtDir = (Resolve-Path (Join-Path $ScriptDir "..\assets\extension")).Path
$ProfileDir = Join-Path $env:LOCALAPPDATA "amz-check-profile"
$DownloadsDir = Join-Path $env:USERPROFILE "Downloads"

function Quote-Arg([string]$value) {
  if ($value -match '[\s"]') { return '"' + ($value -replace '"', '\"') + '"' }
  return $value
}

# 品牌版 Google Chrome 从 137 起直接拒绝 --load-extension：
#   WARNING: extension_service.cc] --load-extension is not allowed in Google
#   Chrome, ignoring.
# 报错发生在浏览器进程里，扩展静默不加载，最后只会看到「runner 页不可用」这种
# 误导性错误。所以这里优先挑能加载扩展的浏览器，找不到就明确说清楚：
#   1. Edge —— Windows 自带，实测能加载（本仓库在 Windows 上的默认选择）
#   2. Chrome for Testing —— 官方为自动化发布的构建，允许 --load-extension
# 需要显式指定时用 -Browser 或 $env:AMZ_BROWSER。
function Find-Browser {
  param([string]$Explicit)

  if ($Explicit) {
    if (Test-Path $Explicit) { return (Resolve-Path $Explicit).Path }
    throw "指定的浏览器不存在: $Explicit"
  }
  if ($env:AMZ_BROWSER -and (Test-Path $env:AMZ_BROWSER)) {
    return (Resolve-Path $env:AMZ_BROWSER).Path
  }

  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "amz-check-chrome\chrome.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return (Resolve-Path $candidate).Path }
  }

  $brandedChrome = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($brandedChrome) {
    # 用 Write-Host + exit 而不是 throw：throw 会让 PowerShell 把这段说明连堆栈
    # 打印两遍，用户真正需要的那两条出路被淹掉
    Write-Host "ERROR: 只找到品牌版 Google Chrome，它从 137 起拒绝 --load-extension，扩展不会加载。"
    Write-Host ""
    Write-Host "可选："
    $edgeHint = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
    Write-Host "  a) 用系统自带的 Edge:"
    Write-Host "     .\scripts\run.ps1 <ASINs> -Browser `"$edgeHint`""
    Write-Host "  b) 下载 Chrome for Testing 解压到 $env:LOCALAPPDATA\amz-check-chrome\"
    Write-Host "     见 docs\runner.md 的「为什么不用 Google Chrome」"
    exit 1
  }

  Write-Host "ERROR: 未找到 Edge / Chrome for Testing。"
  Write-Host "用 -Browser <路径> 或设置 `$env:AMZ_BROWSER 指定。"
  exit 1
}

$BrowserPath = Find-Browser -Explicit $Browser
if (-not (Test-Path (Join-Path $ExtDir "manifest.json"))) { throw "扩展目录不完整: $ExtDir" }

if ($Login) {
  Write-Host "无头环境无界面。持久 profile = $ProfileDir"
  Write-Host "人工登录（会开一个可见窗口，登录后关闭即可，cookie 会落盘）："
  Write-Host ""
  Write-Host "  & '$BrowserPath' --user-data-dir='$ProfileDir' --load-extension='$ExtDir' https://www.amazon.com/ap/signin"
  Write-Host ""
  Write-Host "登录完跑: .\scripts\run.ps1 <ASINs> -CheckLogin 验证"
  exit 0
}

# 只结束用我们这个 profile 的进程，不动用户正在用的浏览器
function Stop-StaleBrowser {
  try {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProfileDir) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {
    Write-Host "  跳过残留进程清理: $($_.Exception.Message)"
  }
}

# Edge/Chrome 把扩展的 service worker 脚本缓存在 profile 里，而且**跨浏览器重启**一直
# 沿用同一份：实测改完扩展代码后，worker 仍跑第一次启动时的旧副本，而 offscreen 文档
# （普通扩展页面，每次从磁盘读）跑的是新代码 —— 表现就是「改动像是完全没生效」，换个
# 全新 profile 却又正常。这里删掉这份脚本缓存强制重新加载。
# 是纯缓存（不含 cookie/登录态，登录不会掉），且必须在浏览器退出之后执行：
# 浏览器活着时它底下的 leveldb 是锁着的。
function Clear-ScriptCache {
  $scriptCache = Join-Path $ProfileDir "Default\Service Worker\ScriptCache"
  if (Test-Path $scriptCache) {
    Remove-Item -Recurse -Force $scriptCache -ErrorAction SilentlyContinue
  }
}

# 端口就绪 != 扩展加载成功。Edge 把真正的浏览器进程挂在 Start-Process 返回的那个进程
# 底下，所以上一轮结束时可能只杀掉了外壳，浏览器还在退场；这时新实例会静默忽略
# --load-extension，扩展根本没注册，也就没有 service worker。下游只会看到
# 「start-new-task 失败: undefined」这种误导性报错。实测两次里撞上一次，所以这里确认
# worker 真的起来了，没起来就重来一轮。
function Start-BrowserWithExtension {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Stop-StaleBrowser
    Start-Sleep -Seconds 2
    if ($FreshProfile -and (Test-Path $ProfileDir)) {
      Write-Host "删除持久 profile（会丢邮编/登录态）: $ProfileDir"
      Remove-Item -Recurse -Force $ProfileDir -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    Clear-ScriptCache

    $proc = Start-Process -FilePath $BrowserPath -ArgumentList $chromeArgs -PassThru

    # 端口起来才算就绪；Chrome 启动失败时这里会超时，给出明确报错而不是让
    # drive.mjs 抛一个看不懂的 cdp timeout
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
      if ($proc.HasExited) { break }
      try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null
        $ready = $true
        break
      } catch {
        Start-Sleep -Seconds 1
      }
    }

    if ($ready) {
      for ($i = 0; $i -lt 20; $i++) {
        $workerUp = $false
        try {
          $workerUp = [bool](@(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3) |
            Where-Object { $_.type -eq "service_worker" })
        } catch { }
        if ($workerUp) { return $proc }
        Start-Sleep -Seconds 1
      }
      Write-Host "  第 $attempt 次启动：浏览器就绪但扩展未加载，重试"
    } else {
      Write-Host "  第 $attempt 次启动：Chromium 未能在端口 $Port 上就绪"
    }

    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }

  Stop-StaleBrowser
  throw "浏览器起来了但扩展始终没加载（--load-extension 被忽略），已重试 3 次。"
}

$chromeArgs = @(
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=glic",          # 内置 Gemini 组件扩展会在 target 列表里冒充目标
  "--user-data-dir=$(Quote-Arg $ProfileDir)",
  "--load-extension=$(Quote-Arg $ExtDir)",
  "--remote-debugging-port=$Port",
  "about:blank"
) -join ' '

Write-Host "浏览器: $BrowserPath"
Write-Host "Profile: $ProfileDir"
$chrome = Start-BrowserWithExtension

try {

  if ($CheckLogin -or $WithReviews) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $loginRaw = & node (Join-Path $ScriptDir "check-login.mjs") --port $Port 2>&1
    $ErrorActionPreference = $previousEap
    Write-Host "LOGIN=$loginRaw"
    $loggedIn = $false
    try { $loggedIn = [bool](($loginRaw | Out-String | ConvertFrom-Json).loggedIn) } catch { }

    if ($CheckLogin) { exit 0 }
    if (-not $loggedIn) {
      Write-Host "ERROR: 差评收集需要登录，当前 profile 未登录。"
      Write-Host "登录指引: .\scripts\run.ps1 --Login；登录后重试，或去掉 -WithReviews。"
      exit 3
    }
  }

  $driveArgs = @(
    $Asins,
    "--zip", "$Zip",
    "--delay", "$Delay",
    "--port", "$Port",
    "--retry", "$Retry",
    "--timeout", "$TimeoutMin"
  )
  if ($MaxImageEdge -ne "") { $driveArgs += @("--max-image-edge", $MaxImageEdge) }
  if ($Chunk -gt 0) { $driveArgs += @("--chunk", "$Chunk") }
  if ($WithReviews) { $driveArgs += "--with-reviews" }

  # $ErrorActionPreference='Stop' 下原生命令只要往 stderr 写一行（node 的警告、
  # 扩展的 console 输出）就会被当成终止错误，所以这里临时放开。
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # Tee-Object 一边透传到控制台一边存进 $driveLines；不要再接 Out-Null，否则
  # 实时输出会被吞掉
  & node (Join-Path $ScriptDir "drive.mjs") @driveArgs 2>&1 | Tee-Object -Variable driveLines
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $previousEap

  $reportPath = ($driveLines | Where-Object { "$_" -match '^REPORT=' } | Select-Object -Last 1)
  if ($reportPath) { $reportPath = "$reportPath".Substring(7) }
  if (-not $reportPath -or -not (Test-Path $reportPath)) {
    Write-Host "链路错误（无 report 产物）"
    exit 1
  }

  # -Encoding UTF8 必需：报告里含中文（如失败原因「未找到标题节点。」），
  # PowerShell 5.1 默认按 ANSI 代码页解码无 BOM 的 UTF-8，会把引号也读坏，
  # 于是 ConvertFrom-Json 直接抛 ArgumentException。
  $report = Get-Content $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ""
  Write-Host "成功 $($report.success) / 失败 $($report.failed)（邮编 $($report.zip)）"
  if ($null -ne $report.peakImageCacheBytes) {
    Write-Host ("图片缓存峰值: {0:N1}MB" -f ($report.peakImageCacheBytes / 1MB))
  }
  if ($report.export) {
    Write-Host ("产物: {0:N2}MB（下载方式 {1}）" -f ($report.export.bytes / 1MB), $report.export.downloadPath)
  }
  if (@($report.failures).Count) {
    Write-Host "失败明细:"
    @($report.failures) | ForEach-Object { Write-Host "  $_" }
  }
  $files = @(@($report.xlsxFiles) + @($report.mainXlsx) | Where-Object { $_ } | Select-Object -Unique)
  Write-Host "XLSX:"
  foreach ($name in $files) { Write-Host "  $(Join-Path $DownloadsDir $name)" }

  if ($rc -ne 0) { exit 1 }
  if ([int]$report.success -eq 0) { exit 2 }
  exit 0
} finally {
  if ($chrome -and -not $chrome.HasExited) {
    Stop-Process -Id $chrome.Id -Force -ErrorAction SilentlyContinue
  }
}
