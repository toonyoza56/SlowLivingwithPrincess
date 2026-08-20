param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "patches\patch-manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$fixtureRoot = Join-Path $repoRoot ("state\test-fixture-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $fixtureRoot "Game.exe") -Force | Out-Null

foreach ($file in $manifest.files) {
    $relativePath = $file.path -replace '/', [IO.Path]::DirectorySeparatorChar
    $destination = Join-Path $fixtureRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

    $backupName = ($file.path -replace '/', '__')
    $source = Join-Path $BackupPath $backupName
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing original backup: $source"
    }
    Copy-Item -LiteralPath $source -Destination $destination

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
    if ($hash -ne $file.originalSha256) {
        throw "Original hash mismatch for $($file.path): $hash"
    }
}

Write-Host "Fixture: $fixtureRoot"
& node (Join-Path $repoRoot "installer\install.mjs") --game $fixtureRoot
if ($LASTEXITCODE -ne 0) { throw "Installer failed with exit code $LASTEXITCODE" }

foreach ($file in $manifest.files) {
    $target = Join-Path $fixtureRoot ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
    if ($hash -ne $file.patchedSha256) {
        throw "Patched hash mismatch for $($file.path): $hash"
    }
}

$fontTarget = Join-Path $fixtureRoot "fonts\NotoSansThai-Regular.ttf"
if (-not (Test-Path -LiteralPath $fontTarget)) { throw "Font was not installed" }
$fontHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fontTarget).Hash.ToLowerInvariant()
if ($fontHash -ne $manifest.assets[0].sha256) { throw "Installed font hash mismatch" }

& node (Join-Path $repoRoot "installer\uninstall.mjs") --game $fixtureRoot
if ($LASTEXITCODE -ne 0) { throw "Uninstaller failed with exit code $LASTEXITCODE" }

foreach ($file in $manifest.files) {
    $target = Join-Path $fixtureRoot ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
    if ($hash -ne $file.originalSha256) {
        throw "Restored hash mismatch for $($file.path): $hash"
    }
}

if (Test-Path -LiteralPath $fontTarget) { throw "Font should have been removed on uninstall" }

Write-Host "Round-trip test passed. Fixture retained at: $fixtureRoot" -ForegroundColor Green
