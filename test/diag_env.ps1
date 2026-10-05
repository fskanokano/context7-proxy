# 环境变量存在性诊断:只打印“是否存在于各作用域/长度”,绝不打印变量值。
# 用法:powershell -NoProfile -ExecutionPolicy Bypass -File test/diag_env.ps1

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$name = 'CONTEXT7_API_KEY'

function Describe([string]$label, $value) {
  if ($null -eq $value) { return "$label = <不存在>" }
  if ($value -eq '') { return "$label = <存在但为空>" }
  return "$label = <存在> 长度=$($value.Length)"
}

Write-Host (Describe -label '进程作用域($env:)' -value $env:CONTEXT7_API_KEY)
Write-Host (Describe -label '用户作用域(HKCU\Environment)' -value ([Environment]::GetEnvironmentVariable($name, 'User')))
Write-Host (Describe -label '机器作用域(HKLM)' -value ([Environment]::GetEnvironmentVariable($name, 'Machine')))
Write-Host "当前用户 = $env:USERDOMAIN\$env:USERNAME"

# 只列出名字匹配的属性名,不打印属性值
$userProps = @(Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue |
    Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)
Write-Host ("HKCU\Environment 中匹配 *CONTEXT7* 的属性名: " + (($userProps | Where-Object { $_ -like '*CONTEXT7*' }) -join ', '))

$volProps = @(Get-ItemProperty 'HKCU:\Volatile Environment' -ErrorAction SilentlyContinue |
    Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)
Write-Host ("HKCU\Volatile Environment 中匹配 *CONTEXT7* 的属性名: " + (($volProps | Where-Object { $_ -like '*CONTEXT7*' }) -join ', '))

$machProps = @(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -ErrorAction SilentlyContinue |
    Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)
Write-Host ("HKLM 环境变量中匹配 *CONTEXT7* 的属性名: " + (($machProps | Where-Object { $_ -like '*CONTEXT7*' }) -join ', '))
