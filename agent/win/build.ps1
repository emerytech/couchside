# Build a self-contained couchside-agent.exe with PyInstaller, so end users
# don't need Python installed. Run on a Windows machine with Python 3.9+:
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# Output: dist\couchside-agent.exe (copy it next to install.ps1, optionally
# with ViGEmClient.dll, and ship those two files).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

python -m pip install --upgrade pyinstaller | Out-Null

# qr.py is the shared encoder in agent/; a standalone copy may sit next to
# this script. Put both on PyInstaller's module search path so `import qr`
# resolves either way.
$qrPath = $here
if (-not (Test-Path (Join-Path $here 'qr.py'))) { $qrPath = Split-Path $here -Parent }

# --noconsole would swallow the log prints; keep the console build and let the
# scheduled task hide the window instead. qr.py is bundled as a module; the
# ViGEmClient.dll (if present next to this script) is bundled as data so the
# _MEIPASS lookup in _load_vigem finds it.
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
$dll = Join-Path $here 'ViGEmClient.dll'
if (Test-Path $dll) { $piArgs += @('--add-binary', "$dll;.") }
$piArgs += (Join-Path $here 'couchsided-win.py')

python -m PyInstaller @piArgs

Write-Host ''
Write-Host "Built: $(Join-Path $here 'dist\couchside-agent.exe')"
