# Build a self-contained couchside-agent.exe with PyInstaller, so end users
# don't need Python installed. Run on a Windows machine with Python 3.9+:
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# Output: dist\couchside-agent.exe. Drop it next to this script in agent\win\ —
# the root install.ps1 finds an exe there and installs it instead of downloading
# the Python agent.
#
# ViGEmClient.dll MUST be next to this script: without it the built agent cannot
# create a virtual pad, reports caps.gamepad=false, and the app hides the Pad tab
# (issue #255). Use -NoGamepad only if you deliberately want a build with no
# controller support.

param([switch]$NoGamepad)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

python -m pip install --upgrade pyinstaller | Out-Null

# qr.py is the shared encoder in agent/; a standalone copy may sit next to
# this script. Put both on PyInstaller's module search path so `import qr`
# resolves either way.
$qrPath = $here
if (-not (Test-Path (Join-Path $here 'qr.py'))) { $qrPath = Split-Path $here -Parent }

# --noconsole would swallow the log prints; keep the console build and let the
# scheduled task hide the window instead. qr.py is bundled as a module;
# ViGEmClient.dll is bundled below (required -- see the block after $piArgs) so
# the _MEIPASS lookup in _load_vigem finds it.
$piArgs = @(
    '--onefile',
    '--name', 'couchside-agent',
    '--paths', $here,
    '--paths', $qrPath,
    '--hidden-import', 'qr',
    # Pin outputs under agent/win regardless of the invoker's cwd, so the
    # "Built:" path below (and the README instructions) are always right.
    '--distpath', (Join-Path $here 'dist'),
    '--workpath', (Join-Path $here 'build'),
    '--specpath', $here
)
# ViGEmClient.dll is REQUIRED, and its absence is a hard error rather than a
# quiet skip. vigem_available() is a DLL-load check, so an agent built without
# this file reports caps.gamepad=false and the app HIDES THE PAD TAB -- the
# headline feature -- on every install made from that build. That shipped: a
# user on 0.4.1-win had ViGEmBus.sys installed and working, no ViGEmClient.dll
# anywhere, and no Pad tab, because this used to be
#     if (Test-Path $dll) { ... }
# which succeeds silently when the file is missing. A build that cannot do
# gamepad must fail loudly here, not surprise someone on their couch.
$dll = Join-Path $here 'ViGEmClient.dll'
if ($NoGamepad) {
    Write-Host 'NOTE: -NoGamepad given; building WITHOUT ViGEmClient.dll.' -ForegroundColor Yellow
    Write-Host '      This agent will report caps.gamepad=false and the app will hide the Pad tab.'
} elseif (-not (Test-Path $dll)) {
    Write-Host ''
    Write-Host 'ERROR: ViGEmClient.dll not found next to build.ps1.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Without it the built agent reports caps.gamepad=false and the'
    Write-Host '  phone app hides the Pad tab entirely (see issue #255).'
    Write-Host ''
    Write-Host '  Get it from the ViGEm client release and drop it in:'
    Write-Host '    https://github.com/nefarius/ViGEmClient/releases'
    Write-Host "    -> $dll"
    Write-Host ''
    Write-Host '  To build a deliberately gamepad-less agent anyway, pass -NoGamepad.'
    throw 'ViGEmClient.dll missing (see message above)'
}
if (-not $NoGamepad) { $piArgs += @('--add-binary', "$dll;.") }
$piArgs += (Join-Path $here 'couchsided-win.py')

python -m PyInstaller @piArgs
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

# Prove the DLL actually made it in, rather than trusting the flag. PyInstaller
# can succeed while dropping a binary it could not resolve.
$exe = Join-Path $here 'dist\couchside-agent.exe'
if (-not (Test-Path $exe)) { throw "build reported success but $exe does not exist" }
if ((-not $NoGamepad) -and -not (Select-String -Path $exe -Pattern 'ViGEmClient\.dll' -Encoding Byte -Quiet -ErrorAction SilentlyContinue)) {
    Write-Host 'WARNING: could not confirm ViGEmClient.dll inside the exe.' -ForegroundColor Yellow
    Write-Host '         Run the agent and check that /api/status reports caps.gamepad=true.'
}

Write-Host ''
Write-Host "Built: $exe"
Write-Host 'Verify before shipping: start it, then GET /api/status and confirm caps.gamepad = true.'
