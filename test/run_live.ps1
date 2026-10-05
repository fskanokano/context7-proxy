# =============================================================================
# 真实上游联调测试包装脚本
# =============================================================================
# 从 Windows 用户环境变量读取 CONTEXT7_API_KEY,并以环境变量的形式传给测试进程。
# 密钥值不会被打印;仅在缺失时给出提示(测试会以占位值运行,上游降级匿名)。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File test/run_live.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 依次尝试:进程 → 用户作用域(HKCU) → 机器作用域(HKLM)
$key = [Environment]::GetEnvironmentVariable('CONTEXT7_API_KEY', 'Process')
$scope = '进程作用域'
if (-not $key) {
  $key = [Environment]::GetEnvironmentVariable('CONTEXT7_API_KEY', 'User')
  $scope = '用户作用域(HKCU)'
}
if (-not $key) {
  $key = [Environment]::GetEnvironmentVariable('CONTEXT7_API_KEY', 'Machine')
  $scope = '机器作用域(HKLM)'
}

if (-not $key) {
  Write-Host 'CONTEXT7_API_KEY: 未在进程/用户/机器任一作用域中找到;测试将以占位值运行(上游会降级为匿名)。'
} else {
  Write-Host "CONTEXT7_API_KEY: 已从 $scope 加载(值不显示)。"
  $env:CONTEXT7_API_KEY = $key
}

Set-Location (Join-Path $PSScriptRoot '..')
deno test -A --no-check test/live_test.ts
