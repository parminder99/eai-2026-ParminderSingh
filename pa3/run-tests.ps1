$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dockerBin = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$env:Path = "$dockerBin;$runtimeRoot\node\bin;$env:Path"

docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Open Docker Desktop and wait until the engine is running, then retry.' }
docker compose up -d --build --wait
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Review the error above.' }

if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
    npm.cmd --prefix tests ci
    if ($LASTEXITCODE -ne 0) { throw 'Test dependency installation failed.' }
    npm.cmd --prefix tests test
} else {
    $pnpmCommand = Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd'
    if (-not (Test-Path -LiteralPath $pnpmCommand)) { throw 'Install Node.js LTS (including npm), then retry.' }
    & $pnpmCommand --dir tests install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Test dependency installation failed.' }
    & $pnpmCommand --dir tests test
}
if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Review the output above.' }
Write-Host 'All supplied public tests passed.' -ForegroundColor Green
