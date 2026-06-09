Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) {
    $cargoCommand.Source
} else {
    $fallback = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $fallback) { $fallback } else { $null }
}

if (-not $cargoPath) {
    Write-Error 'Cargo was not found. Install Rust stable MSVC toolchain first.'
}

$perlCommand = Get-Command perl -ErrorAction SilentlyContinue
$perlPath = if ($perlCommand) {
    $perlCommand.Source
} else {
    $fallback = 'C:\Strawberry\perl\bin\perl.exe'
    if (Test-Path $fallback) { $fallback } else { $null }
}

if ($perlPath) {
    $perlDir = Split-Path -Parent $perlPath
    if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $perlDir })) {
        $env:PATH = "$perlDir;$env:PATH"
    }
    Write-Host "Using Perl from: $perlPath"
} else {
    Write-Warning 'Perl was not found on PATH. vendored OpenSSL builds may fail on Windows.'
}

Write-Host "Using cargo from: $cargoPath"
& $cargoPath check --manifest-path "src-tauri/Cargo.toml"

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host 'Rust check passed.'
