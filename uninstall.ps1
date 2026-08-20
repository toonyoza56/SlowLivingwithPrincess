param(
    [string]$GamePath,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (Get-Process -Name Game -ErrorAction SilentlyContinue) {
    throw "กรุณาปิดเกมก่อนถอนม็อด"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "ไม่พบ Node.js กรุณาติดตั้ง Node.js 18 ขึ้นไปก่อน"
}

$arguments = @("$PSScriptRoot\installer\uninstall.mjs")
if ($GamePath) {
    $arguments += @("--game", $GamePath)
}
if ($Force) {
    $arguments += "--force"
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "ถอนม็อดไม่สำเร็จ (exit code $LASTEXITCODE)"
}
