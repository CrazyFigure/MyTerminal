Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$FallbackPath,
        [string]$InstallHint
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    if ($FallbackPath -and (Test-Path $FallbackPath)) {
        return $FallbackPath
    }

    Write-Error $InstallHint
}

$nodePath = Require-Command -Name 'node' -InstallHint 'Node.js was not found. Install Node.js 20.19+ or 22.12+.'
$npmPath = Require-Command -Name 'npm' -InstallHint 'npm was not found. Reinstall Node.js with npm included.'
$cargoPath = Require-Command -Name 'cargo' -FallbackPath (Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe') -InstallHint 'Cargo was not found. Install Rust stable MSVC toolchain first.'
$perlPath = Require-Command -Name 'perl' -FallbackPath 'C:\Strawberry\perl\bin\perl.exe' -InstallHint 'Perl was not found. Install Strawberry Perl or add perl.exe to PATH.'

$perlDir = Split-Path -Parent $perlPath
if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $perlDir })) {
    $env:PATH = "$perlDir;$env:PATH"
}

Write-Host "Node.js: $nodePath"
& $nodePath -v

Write-Host "npm: $npmPath"
& $npmPath -v

Write-Host "Cargo: $cargoPath"
& $cargoPath -V

Write-Host "Perl: $perlPath"
& $perlPath -v

$linkCommand = Get-Command link.exe -ErrorAction SilentlyContinue
if ($linkCommand) {
    Write-Host "link.exe: $($linkCommand.Source)"
} else {
    Write-Warning 'link.exe is not currently on PATH. If Rust OpenSSL builds fail, open a Developer PowerShell or install/load Visual Studio Build Tools 2022.'
}

Write-Host 'Environment check passed.'
