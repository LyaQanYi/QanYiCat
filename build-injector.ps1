<#
.SYNOPSIS
    Build qanyicat-launcher.exe + qanyicat_hook.dll with the MinGW / Chinese-path workaround.

.DESCRIPTION
    The injector crate must link with MinGW dlltool (kernel32 import library), which
    chokes on Chinese characters in `CARGO_TARGET_DIR`. The fix is to build into a
    Latin-only path (default C:\qyc-cargo-target) and copy the two artifacts back
    into tools\qanyicat-injector\target\release\ so quick-start.bat and the inner
    hook loader-path walk-up can find them at the canonical location.

    Resolves MinGW from (in order):
      1. -MingwBin parameter
      2. $env:QANYICAT_MINGW_BIN
      3. <repo>\..\node22\mingw64\bin (the project's bundled toolchain, per layout memory)
      4. C:\msys64\mingw64\bin
      5. C:\ProgramData\mingw64\bin
      6. Whatever `gcc.exe` is already on PATH

.PARAMETER Clean
    Run `cargo clean` first.

.PARAMETER Dev
    Build the debug profile instead of release. Output goes to <target>\debug\.
    (Named -Dev because -Debug collides with PowerShell's common parameters.)

.PARAMETER SkipCopy
    Skip the copy-back step (artifacts stay in <TargetDir>\<profile>\ only).

.PARAMETER TargetDir
    Override the Latin-only CARGO_TARGET_DIR. Default: C:\qyc-cargo-target.

.PARAMETER MingwBin
    Override the MinGW bin directory. See DESCRIPTION for the resolution order.

.EXAMPLE
    .\build-injector.ps1
    Release build, copy artifacts back, use bundled MinGW.

.EXAMPLE
    .\build-injector.ps1 -Clean -Dev
    Fresh debug rebuild.
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Dev,
    [switch]$SkipCopy,
    [string]$TargetDir = 'C:\qyc-cargo-target',
    [string]$MingwBin
)

$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$InjectorDir = Join-Path $RepoRoot 'tools\qanyicat-injector'
# Note: $Profile is a PowerShell reserved automatic variable; use $BuildProfile.
$BuildProfile = if ($Dev) { 'debug' } else { 'release' }
$ArtifactDir = Join-Path $TargetDir $BuildProfile
$CanonicalDir = Join-Path $InjectorDir "target\$BuildProfile"

if (-not (Test-Path -LiteralPath $InjectorDir)) {
    throw "injector workspace not found at $InjectorDir"
}

function Resolve-MingwBin {
    if ($MingwBin) {
        if (-not (Test-Path -LiteralPath (Join-Path $MingwBin 'gcc.exe'))) {
            throw "-MingwBin '$MingwBin' has no gcc.exe"
        }
        return $MingwBin
    }
    if ($env:QANYICAT_MINGW_BIN) {
        if (Test-Path -LiteralPath (Join-Path $env:QANYICAT_MINGW_BIN 'gcc.exe')) {
            return $env:QANYICAT_MINGW_BIN
        }
    }
    $candidates = @(
        (Join-Path $RepoRoot '..\node22\mingw64\bin'),
        'C:\msys64\mingw64\bin',
        'C:\ProgramData\mingw64\bin',
        'C:\ProgramData\chocolatey\lib\mingw\tools\install\mingw64\bin'
    )
    foreach ($c in $candidates) {
        $resolved = try { (Resolve-Path -LiteralPath $c -ErrorAction Stop).Path } catch { $null }
        if ($resolved -and (Test-Path -LiteralPath (Join-Path $resolved 'gcc.exe'))) {
            return $resolved
        }
    }
    # Last resort: maybe gcc is already on PATH (CI environment).
    $existing = Get-Command gcc.exe -ErrorAction SilentlyContinue
    if ($existing) {
        return (Split-Path -Parent $existing.Source)
    }
    throw 'MinGW gcc.exe not found. Set -MingwBin or $env:QANYICAT_MINGW_BIN, or install MinGW.'
}

function Resolve-Cargo {
    $cmd = Get-Command cargo.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bases = @()
    if ($env:CARGO_HOME)  { $bases += $env:CARGO_HOME }
    if ($env:USERPROFILE) { $bases += (Join-Path $env:USERPROFILE '.cargo') }
    foreach ($b in $bases) {
        $candidate = Join-Path $b 'bin\cargo.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'cargo.exe not found. Install Rust (https://rustup.rs) or set $env:CARGO_HOME.'
}

$mingwBinResolved = Resolve-MingwBin
$cargoExe = Resolve-Cargo
Write-Host "[build-injector] mingw bin     : $mingwBinResolved"
Write-Host "[build-injector] cargo         : $cargoExe"
Write-Host "[build-injector] target dir    : $TargetDir  (profile=$BuildProfile)"
Write-Host "[build-injector] injector root : $InjectorDir"
Write-Host "[build-injector] copy-back to  : $CanonicalDir"
Write-Host ''

# Prepend MinGW + cargo bin + set Latin-only target dir for this process only —
# don't leak to the user's shell.
$cargoBin = Split-Path -Parent $cargoExe
$env:PATH = "$mingwBinResolved;$cargoBin;$env:PATH"
$env:CARGO_TARGET_DIR = $TargetDir

$cargoArgs = @('build')
if (-not $Dev) { $cargoArgs += '--release' }

# PowerShell 5.1 wraps native-cmd stderr lines as NativeCommandError records,
# which $ErrorActionPreference='Stop' would treat as fatal. cargo writes warns
# to stderr even on success, so we explicitly suppress that conversion around
# the cargo invocations and gate purely on $LASTEXITCODE.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$Cwd)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $Cwd
        try {
            & $Exe @Arguments
        } finally { Pop-Location }
    } finally { $ErrorActionPreference = $prev }
    return $LASTEXITCODE
}

if ($Clean) {
    Write-Host '[build-injector] cargo clean ...'
    $code = Invoke-Native -Exe $cargoExe -Arguments @('clean') -Cwd $InjectorDir
    if ($code -ne 0) { throw "cargo clean exited $code" }
}

Write-Host "[build-injector] cargo $($cargoArgs -join ' ') ..."
$buildStart = Get-Date
$code = Invoke-Native -Exe $cargoExe -Arguments $cargoArgs -Cwd $InjectorDir
if ($code -ne 0) { throw "cargo build exited $code" }
$buildElapsed = (Get-Date) - $buildStart
Write-Host ("[build-injector] cargo done in {0:N1}s" -f $buildElapsed.TotalSeconds)

$artifacts = @('qanyicat-launcher.exe', 'qanyicat_hook.dll')

# Verify both artifacts landed in the Latin-only target dir.
$missing = @()
foreach ($a in $artifacts) {
    if (-not (Test-Path -LiteralPath (Join-Path $ArtifactDir $a))) { $missing += $a }
}
if ($missing.Count -gt 0) {
    throw "build finished but missing artifacts in $ArtifactDir`: $($missing -join ', ')"
}

if ($SkipCopy) {
    Write-Host "[build-injector] -SkipCopy: artifacts remain only at $ArtifactDir"
    return
}

if (-not (Test-Path -LiteralPath $CanonicalDir)) {
    New-Item -ItemType Directory -Path $CanonicalDir -Force | Out-Null
}

foreach ($a in $artifacts) {
    $src = Join-Path $ArtifactDir $a
    $dst = Join-Path $CanonicalDir $a
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $size = (Get-Item -LiteralPath $dst).Length
    Write-Host ("[build-injector] copied {0,-24} -> {1}  ({2:N0} bytes)" -f $a, $dst, $size)
}

Write-Host ''
Write-Host '[build-injector] done.'
