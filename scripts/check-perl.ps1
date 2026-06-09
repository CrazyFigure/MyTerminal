Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$perlCommand = Get-Command perl -ErrorAction SilentlyContinue
$perlPath = if ($perlCommand) {
    $perlCommand.Source
} else {
    $fallback = 'C:\Strawberry\perl\bin\perl.exe'
    if (Test-Path $fallback) { $fallback } else { $null }
}

if (-not $perlPath) {
    Write-Error "Perl was not found. Install Strawberry Perl or add perl.exe to PATH."
}

Write-Host "Perl found at: $perlPath"
& $perlPath -v

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host 'Perl check passed.'
