param(
    [string]$GamePath
)

$ErrorActionPreference = "Stop"

if (Get-Process -Name Game -ErrorAction SilentlyContinue) {
    throw "กรุณาปิดเกมก่อนติดตั้งม็อด"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "ไม่พบ Node.js กรุณาติดตั้ง Node.js 18 ขึ้นไปก่อน"
}

$arguments = @("$PSScriptRoot\installer\install.mjs")
if ($GamePath) {
    $arguments += @("--game", $GamePath)
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "ติดตั้งม็อดไม่สำเร็จ (exit code $LASTEXITCODE)"
}
