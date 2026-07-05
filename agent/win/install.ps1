# Couchside Windows agent installer.
#
# ONE-LINE INSTALL (run in PowerShell; it self-elevates via UAC):
#
#   irm https://couchside.tv/install.ps1 | iex
#
# With options (download the script so params survive the pipe):
#
#   irm https://couchside.tv/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Port 9000 -NoGamepad
#
# Uninstall:
#
#   irm https://couchside.tv/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# What it does (all reversible with -Uninstall):
#   1. installs Python 3 (via winget) if it isn't already present
#   2. downloads the agent to %LOCALAPPDATA%\Couchside\agent\ (or copies it
#      from a local checkout when run from agent\win\)
#   3. installs the ViGEmBus driver + client DLL for the virtual gamepad
#      (skip with -NoGamepad)
#   4. creates %ProgramData%\Couchside\token (pairing secret) + config.json
#   5. opens TCP 8787 inbound on the Private firewall profile
#   6. registers a Scheduled Task that starts the agent at logon, in the
#      interactive desktop session, NON-elevated (virtual input can't reach
#      the desktop from a session-0 service; unprivileged mirrors the Linux
#      agent's least-privilege model — its LAN-facing action/launcher API
#      must never run as admin)
#   7. opens http://localhost:8787/pair so you can scan the QR to pair

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [int]$Port = 8787,
    [switch]$NoFirewall,
    [switch]$NoGamepad,      # skip the ViGEmBus virtual-controller install
    [switch]$KeepHibernate,  # skip `powercfg /hibernate off`
    [string]$Ref = 'main'    # git ref to download the agent from
)

$ErrorActionPreference = 'Stop'
# GitHub requires TLS 1.2; Windows PowerShell 5.1 may default lower.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SelfUrl    = 'https://couchside.tv/install.ps1'
$Repo       = 'emerytech/couchside'
$RawBase    = "https://raw.githubusercontent.com/$Repo/$Ref/agent"
$TaskName   = 'Couchside Agent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Couchside\agent'
$DataDir    = Join-Path $env:ProgramData 'Couchside'
$TokenPath  = Join-Path $DataDir 'token'
$ConfigPath = Join-Path $DataDir 'config.json'
$FwRule     = 'Couchside Agent'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- self-elevate (works whether run from a file OR piped via irm|iex) -------
# The firewall rule + scheduled task need admin, so relaunch under UAC. The
# elevated instance keeps the SAME user (UAC elevation doesn't switch users),
# so the logon task still targets the person installing.
if (-not (Test-Admin)) {
    Write-Host 'Couchside needs administrator rights (firewall + scheduled task). Elevating via UAC...'
    $fwd = @()
    if ($Uninstall)      { $fwd += '-Uninstall' }
    if ($NoFirewall)     { $fwd += '-NoFirewall' }
    if ($NoGamepad)      { $fwd += '-NoGamepad' }
    if ($KeepHibernate)  { $fwd += '-KeepHibernate' }
    $fwd += "-Port $Port"; $fwd += "-Ref $Ref"
    if ($PSCommandPath) {
        # Run from a file: relaunch that same file elevated.
        $a = @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',"`"$PSCommandPath`"") + $fwd
    } else {
        # Piped from the web: re-fetch and run in the elevated window, carrying
        # the resolved params through a scriptblock so options aren't lost.
        $inner = "& ([scriptblock]::Create((irm $SelfUrl))) $($fwd -join ' ')"
        $a = @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command',$inner)
    }
    try { Start-Process powershell -Verb RunAs -ArgumentList $a }
    catch { throw 'Elevation was declined. Re-run from an elevated PowerShell (Run as administrator).' }
    return
}

# --- shared helpers ----------------------------------------------------------
function Stop-AgentTask {
    # Stop-ScheduledTask kills a running instance; Unregister does NOT, so an
    # upgrade must stop first or copying over the running files/exe conflicts.
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

function Uninstall-Couchside {
    Write-Host 'Uninstalling Couchside agent...'
    Stop-AgentTask
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Write-Host "Left in place (delete manually to unpair phones): $DataDir"
    Write-Host 'Note: if install disabled hibernation, restore it with `powercfg /hibernate on`.'
    Write-Host 'Kept Python and the ViGEmBus driver (uninstall from Apps & features if unwanted).'
    Write-Host 'Done.'
}

if ($Uninstall) { Uninstall-Couchside; exit 0 }

function Test-RealPython3 {
    # True if $exe runs and is Python 3. The Microsoft Store stub exits nonzero
    # (it just opens the Store), so this rejects it.
    param([string]$exe)
    if (-not $exe -or ($exe -like '*\Microsoft\WindowsApps\*')) { return $false }
    try {
        $v = & $exe -c 'import sys; print(sys.version_info[0])' 2>$null
        return ($LASTEXITCODE -eq 0 -and "$v".Trim() -eq '3')
    } catch { return $false }
}

function Resolve-Python {
    # Full path to a real Python 3 (pythonw.exe preferred so the task is
    # windowless), or $null. Robust to a stale PATH (right after installing
    # Python) and per-user vs machine installs: checks PATH, the `py` launcher,
    # and the well-known python.org install dirs.
    $cands = @()
    foreach ($n in 'pythonw.exe','python.exe') {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { $cands += $c.Source }
    }
    $pyl = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pyl) {
        try {
            $exe = & $pyl.Source -3 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe) {
                $pw = Join-Path (Split-Path $exe) 'pythonw.exe'
                if (Test-Path $pw) { $cands += $pw }
                $cands += $exe
            }
        } catch { }
    }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)},
               (Join-Path $env:LOCALAPPDATA 'Programs\Python'))
    foreach ($base in $bases) {
        if (-not $base -or -not (Test-Path $base)) { continue }
        Get-ChildItem -Path $base -Filter 'Python3*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            foreach ($exe in 'pythonw.exe','python.exe') {
                $f = Join-Path $_.FullName $exe
                if (Test-Path $f) { $cands += $f }
            }
        }
    }
    foreach ($c in $cands) {
        $probe = $c
        if ($c -like '*pythonw.exe') {
            $pe = Join-Path (Split-Path $c) 'python.exe'
            if (Test-Path $pe) { $probe = $pe } else { continue }
        }
        if (Test-RealPython3 $probe) { return $c }
    }
    return $null
}

function Get-Winget {
    $w = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($w -and $w.Source -notlike '*\Microsoft\WindowsApps\*') { return $w.Source }
    # The WindowsApps alias is the real winget on a machine that has App
    # Installer; only reject it if it doesn't actually run.
    if ($w) {
        try { & $w.Source --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return $w.Source } } catch { }
    }
    return $null
}

function Install-WingetPackage {
    param([string]$Id, [string]$Label)
    $wg = Get-Winget
    if (-not $wg) { return $false }
    Write-Host "Installing $Label via winget ($Id)..."
    & $wg install --id $Id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Null
    return $true
}

# --- 1. resolve the agent source: local checkout, else download --------------
$here    = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$usePython = $true
$pyPath  = $null

Stop-AgentTask
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$localExe = if ($here) { Join-Path $here 'couchside-agent.exe' } else { $null }
$localPy  = if ($here) { Join-Path $here 'couchsided-win.py' }  else { $null }

if ($localExe -and (Test-Path $localExe)) {
    # Prebuilt exe: no Python needed.
    $usePython = $false
    Copy-Item $localExe (Join-Path $InstallDir 'couchside-agent.exe') -Force
    Write-Host 'Using local couchside-agent.exe'
    $localQr = Join-Path $here 'qr.py'
    if (-not (Test-Path $localQr)) { $localQr = Join-Path (Split-Path $here -Parent) 'qr.py' }
    if (Test-Path $localQr) { Copy-Item $localQr (Join-Path $InstallDir 'qr.py') -Force }
    $localDll = Join-Path $here 'ViGEmClient.dll'
    if (Test-Path $localDll) { Copy-Item $localDll (Join-Path $InstallDir 'ViGEmClient.dll') -Force }
}
else {
    # Python path (local checkout or web download). Ensure Python first.
    $pyPath = Resolve-Python
    if (-not $pyPath) {
        if (-not (Install-WingetPackage 'Python.Python.3.12' 'Python 3.12')) {
            throw 'Python 3 is required and winget is unavailable. Install Python 3 from https://python.org (check "Add to PATH"), then re-run.'
        }
        $pyPath = Resolve-Python
        if (-not $pyPath) { throw 'Python installed but could not be located. Open a new PowerShell and re-run the installer.' }
    }
    Write-Host "Using Python: $pyPath"

    if ($localPy -and (Test-Path $localPy)) {
        Copy-Item $localPy (Join-Path $InstallDir 'couchsided-win.py') -Force
        $localQr = Join-Path $here 'qr.py'
        if (-not (Test-Path $localQr)) { $localQr = Join-Path (Split-Path $here -Parent) 'qr.py' }
        if (Test-Path $localQr) { Copy-Item $localQr (Join-Path $InstallDir 'qr.py') -Force }
        Write-Host 'Installed agent from local checkout.'
    } else {
        Write-Host "Downloading agent from $RawBase ..."
        Invoke-WebRequest -UseBasicParsing "$RawBase/win/couchsided-win.py" -OutFile (Join-Path $InstallDir 'couchsided-win.py')
        Invoke-WebRequest -UseBasicParsing "$RawBase/qr.py"                 -OutFile (Join-Path $InstallDir 'qr.py')
        # Sanity-check the download compiles before we wire it to a logon task.
        & $pyPath -m py_compile (Join-Path $InstallDir 'couchsided-win.py')
        if ($LASTEXITCODE -ne 0) { throw 'Downloaded agent failed to compile — aborting.' }
    }
}

# The agent runs NON-elevated but rewrites config.json when launchers change;
# grant this user Modify on the data dir (the token's own ACL still overrides).
icacls $DataDir /grant "$($env:USERNAME):(OI)(CI)M" | Out-Null

# --- 2. virtual gamepad: ViGEmBus driver + client DLL (optional) --------------
if (-not $NoGamepad) {
    if (-not (Get-Service -Name ViGEmBus -ErrorAction SilentlyContinue)) {
        Install-WingetPackage 'ViGEm.ViGEmBus' 'ViGEmBus (virtual gamepad driver)' | Out-Null
    }
    $dllDest = Join-Path $InstallDir 'ViGEmClient.dll'
    if (-not (Test-Path $dllDest) -and $usePython -and $pyPath) {
        # Fetch the official ViGEmClient.dll bundled in the vgamepad PyPI sdist
        # (redistributable). Best-effort: gamepad is the only thing affected.
        try {
            # extractall(filter='data') AND warning suppression keep this
            # snippet SILENT on stderr: any native stderr write would become a
            # terminating NativeCommandError under $ErrorActionPreference=Stop.
            $fetch = @'
import glob, os, shutil, subprocess, sys, tarfile, warnings
warnings.filterwarnings("ignore")
tmp = os.path.join(os.environ["TEMP"], "couchside-vigem")
os.makedirs(tmp, exist_ok=True)
subprocess.run([sys.executable, "-m", "pip", "download", "vgamepad", "--no-deps", "-d", tmp],
               capture_output=True)
tgz = glob.glob(os.path.join(tmp, "vgamepad-*.tar.gz"))
if tgz:
    try:
        with tarfile.open(tgz[0]) as t: t.extractall(os.path.join(tmp, "src"), filter="data")
    except TypeError:
        with tarfile.open(tgz[0]) as t: t.extractall(os.path.join(tmp, "src"))
    hit = glob.glob(os.path.join(tmp, "src", "**", "x64", "ViGEmClient.dll"), recursive=True)
    if hit: shutil.copy(hit[0], sys.argv[1])
'@
            $tmpPy = Join-Path $env:TEMP 'couchside-fetchdll.py'
            [IO.File]::WriteAllText($tmpPy, $fetch)
            # Use the CONSOLE python.exe, not pythonw.exe: pythonw is
            # GUI-subsystem and PowerShell won't block on it, so the Test-Path
            # check below would race the still-running pip download.
            $pyExe = $pyPath
            if ($pyPath -like '*pythonw.exe') {
                $sib = Join-Path (Split-Path $pyPath) 'python.exe'
                if (Test-Path $sib) { $pyExe = $sib }
            }
            # EAP=Continue for the call so a stray native stderr line can't
            # abort the fetch (belt-and-suspenders with the silent snippet).
            $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            & $pyExe $tmpPy $dllDest 2>$null | Out-Null
            $ErrorActionPreference = $eap
            Remove-Item $tmpPy -Force -ErrorAction SilentlyContinue
        } catch { }
    }
    if (Test-Path $dllDest) { Write-Host 'Virtual gamepad ready (ViGEmBus + client DLL).' }
    else { Write-Host 'Gamepad driver step incomplete; the pad may be unavailable (everything else works).' }
}

# --- 3. token (kept across reinstalls so paired phones keep working) ---------
if (-not (Test-Path $TokenPath)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [IO.File]::WriteAllText($TokenPath, $token)  # BOM-less, no trailing newline
    # Language-neutral SIDs (English "Administrators" fails on localized Windows):
    # S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, plus the installing user.
    icacls $TokenPath /inheritance:r /grant:r '*S-1-5-18:R' '*S-1-5-32-544:F' "$($env:USERNAME):R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed to restrict $TokenPath (exit $LASTEXITCODE)" }
    Write-Host "Created token: $TokenPath"
} else {
    Write-Host "Kept existing token: $TokenPath"
}

# --- 4. initial config (kept across reinstalls) -------------------------------
if (-not (Test-Path $ConfigPath)) {
    $config = [ordered]@{
        port  = $Port
        units = @( [ordered]@{ name = 'Audiosrv'; scope = 'system' } )
        actions = [ordered]@{
            'restart-explorer' = [ordered]@{
                label = 'Restart Explorer'
                description = 'Restart the Windows shell (explorer.exe), fixes a wedged desktop/taskbar'
                danger = 'medium'
                cmd = @('powershell','-NoProfile','-Command','Stop-Process -Name explorer -Force; Start-Process explorer.exe')
            }
            'lock' = [ordered]@{
                label = 'Lock Screen'; description = 'Lock the Windows session'
                danger = 'low'; cmd = @('rundll32.exe','user32.dll,LockWorkStation')
            }
            'suspend' = [ordered]@{
                label = 'Suspend'
                description = 'Suspend the box to RAM; wake it from the app over Wake-on-LAN'
                danger = 'medium'
                cmd = @('rundll32.exe','powrprof.dll,SetSuspendState','0,1,0'); detached = $true
            }
            'reboot' = [ordered]@{
                label = 'Reboot'; description = 'Reboot the box'; danger = 'high'
                cmd = @('shutdown','/r','/t','0'); detached = $true
            }
            'poweroff' = [ordered]@{
                label = 'Power Off'; description = 'Power off the box'; danger = 'high'
                cmd = @('shutdown','/s','/t','0'); detached = $true
            }
        }
        action_order = @('restart-explorer','lock','suspend','reboot','poweroff')
    }
    if (Get-Service -Name 'Steam Client Service' -ErrorAction SilentlyContinue) {
        $config.units += [ordered]@{ name = 'Steam Client Service'; scope = 'system' }
    }
    $json = $config | ConvertTo-Json -Depth 6
    # BOM-less UTF-8: PS 5.1's `Set-Content -Encoding utf8` prepends a BOM,
    # which json.load rejects (the agent would fall back to built-in defaults).
    [IO.File]::WriteAllText($ConfigPath, $json + "`n")
    Write-Host "Created config: $ConfigPath"
} else {
    Write-Host "Kept existing config: $ConfigPath"
    try {
        $cfgPort = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).port
        if ($cfgPort -is [int] -and $cfgPort -ge 1 -and $cfgPort -le 65535) { $Port = $cfgPort }
    } catch { }
}

# --- 5. hibernate off so SetSuspendState means SLEEP, not hibernate ----------
if (-not $KeepHibernate) {
    & powercfg /hibernate off | Out-Null
    Write-Host 'Disabled hibernation (so Suspend sleeps to RAM; -KeepHibernate to skip).'
}

# --- 6. firewall (Private profile only: LAN-only plain-HTTP agent) -----------
if (-not $NoFirewall) {
    Remove-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FwRule -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Write-Host "Firewall: allowed TCP $Port on the Private profile."
    # The rule only applies on a Private network. A LAN classed Public blocks
    # the phone; warn with the one-line fix rather than silently changing it.
    $pub = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
    if ($pub) {
        Write-Host ''
        Write-Host 'WARNING: an active network is set to "Public", which blocks pairing.' -ForegroundColor Yellow
        foreach ($p in $pub) {
            Write-Host ("  Set it Private:  Set-NetConnectionProfile -InterfaceAlias '{0}' -NetworkCategory Private" -f $p.InterfaceAlias)
        }
    }
}

# --- 7. scheduled task: at logon, current user, interactive, non-elevated ----
# No --port argument: the agent reads the port from config.json, so a config
# edit is honored after a restart (matches the Linux systemd unit).
if ($usePython) {
    $exe = $pyPath
    $arg = ('"{0}"' -f (Join-Path $InstallDir 'couchsided-win.py'))
} else {
    $exe = Join-Path $InstallDir 'couchside-agent.exe'
    $arg = $null
}
$action = if ($arg) {
    New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $InstallDir
} else {
    New-ScheduledTaskAction -Execute $exe -WorkingDirectory $InstallDir
}
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' registered and started."

# --- 8. pairing --------------------------------------------------------------
Write-Host ''
Write-Host '=========================================================='
Write-Host ' Couchside agent installed.'
Write-Host ''
Write-Host " Pair your phone: open  http://localhost:$Port/pair"
Write-Host ' on THIS machine and scan the QR with the Couchside app'
Write-Host ' (phone must be on the same Wi-Fi/LAN).'
Write-Host ''
Write-Host " Token file: $TokenPath"
Write-Host '=========================================================='
try { Start-Process "http://localhost:$Port/pair" -ErrorAction Stop } catch {
    Write-Host " (open the pairing page manually: http://localhost:$Port/pair)"
}
