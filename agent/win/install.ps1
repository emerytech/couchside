# Couchside Windows agent installer.
#
# Run from an ELEVATED PowerShell prompt (admin is needed for the firewall
# rule and to register the scheduled task):
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# What it does:
#   1. installs the agent to %LOCALAPPDATA%\Couchside\agent\
#   2. creates %ProgramData%\Couchside\token (pairing secret) + config.json
#   3. opens TCP 8787 in Windows Firewall (Private profile only)
#   4. registers a Scheduled Task "Couchside Agent" that starts the agent at
#      logon of the current user, IN the interactive session (virtual input
#      cannot work from a session-0 service). The task runs NON-elevated:
#      shutdown/reboot/suspend/lock, SendInput, and ViGEm all work for a
#      standard interactive user, and keeping the agent unprivileged mirrors
#      the Linux agent's least-privilege model (its network-facing action
#      and launcher surface must not hand out admin-level execution).
#   5. starts the task and prints the pairing URL
#
# Prerequisites:
#   - Python 3.9+ on PATH (https://python.org, check "Add to PATH"), OR a
#     prebuilt couchside-agent.exe next to this script (see build.ps1)
#   - ViGEmBus driver for the virtual gamepad (optional; everything else
#     works without it): https://github.com/nefarius/ViGEmBus/releases

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [int]$Port = 8787,
    [switch]$NoFirewall,
    [switch]$KeepHibernate  # skip `powercfg /hibernate off` (see README)
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'Couchside Agent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Couchside\agent'
$DataDir    = Join-Path $env:ProgramData 'Couchside'
$TokenPath  = Join-Path $DataDir 'token'
$ConfigPath = Join-Path $DataDir 'config.json'
$FwRule     = 'Couchside Agent'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated (Administrator) PowerShell.'
    }
}

function Stop-AgentTask {
    # Stop-ScheduledTask kills running instances; Unregister does NOT, so an
    # upgrade must stop first or the exe copy hits a sharing violation (and
    # python mode would end up with two agents racing for the port).
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
    Write-Host 'Done.'
}

Assert-Admin
if ($Uninstall) { Uninstall-Couchside; exit 0 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- 1. resolve how the agent will run (exe preferred, then python) ---------
$exeSrc = Join-Path $here 'couchside-agent.exe'
$pySrc  = Join-Path $here 'couchsided-win.py'
# qr.py is the shared encoder in agent/; a standalone distribution may also
# drop it next to install.ps1. Prefer the local copy, else the parent dir.
$qrSrc  = Join-Path $here 'qr.py'
if (-not (Test-Path $qrSrc)) { $qrSrc = Join-Path (Split-Path $here -Parent) 'qr.py' }

function Test-RealPython3 {
    # True if $exe runs and is Python 3. The Microsoft Store stub exits
    # nonzero (it just opens the Store), so this rejects it.
    param([string]$exe)
    if (-not $exe -or ($exe -like '*\Microsoft\WindowsApps\*')) { return $false }
    try {
        $v = & $exe -c 'import sys; print(sys.version_info[0])' 2>$null
        return ($LASTEXITCODE -eq 0 -and "$v".Trim() -eq '3')
    } catch { return $false }
}

function Resolve-Python {
    # Return a full path to a real Python 3 interpreter (pythonw.exe preferred
    # so the scheduled task runs windowless), or $null. Robust to a stale PATH
    # (common right after installing Python) and per-user vs machine installs:
    # checks PATH, the `py` launcher (py.exe lands in C:\Windows, always on
    # PATH), and the well-known python.org install dirs.
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
        # Validate with python.exe (pythonw is windowless and yields no output
        # to capture); if pythonw sits beside a valid python.exe, use pythonw.
        $probe = $c
        if ($c -like '*pythonw.exe') {
            $pe = Join-Path (Split-Path $c) 'python.exe'
            if (Test-Path $pe) { $probe = $pe } else { continue }
        }
        if (Test-RealPython3 $probe) { return $c }
    }
    return $null
}

$usePython = $false
if (Test-Path $exeSrc) {
    Write-Host 'Using prebuilt couchside-agent.exe'
} elseif (Test-Path $pySrc) {
    $usePython = $true
    $pyPath = Resolve-Python
    if (-not $pyPath) {
        throw 'Neither couchside-agent.exe nor a working Python 3 was found. Install Python 3 from python.org (check "Add to PATH"), or build the exe with build.ps1.'
    }
    Write-Host "Using Python: $pyPath"
} else {
    throw "Nothing to install: put couchside-agent.exe or couchsided-win.py next to install.ps1 (looked in $here)."
}

# --- 2. stop any running agent, then install files ---------------------------
Stop-AgentTask
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# The agent runs NON-elevated as this user but must rewrite config.json in
# ProgramData when launchers are added/removed from the app. Grant Modify on
# the data dir (the token file's own ACL below still overrides inheritance).
icacls $DataDir /grant "$($env:USERNAME):(OI)(CI)M" | Out-Null

if ($usePython) {
    Copy-Item $pySrc (Join-Path $InstallDir 'couchsided-win.py') -Force
    if (Test-Path $qrSrc) { Copy-Item $qrSrc (Join-Path $InstallDir 'qr.py') -Force }
} else {
    Copy-Item $exeSrc (Join-Path $InstallDir 'couchside-agent.exe') -Force
}
# ViGEmClient.dll rides along if present (needed for the virtual gamepad).
$dll = Join-Path $here 'ViGEmClient.dll'
if (Test-Path $dll) { Copy-Item $dll (Join-Path $InstallDir 'ViGEmClient.dll') -Force }

# --- 3. token (kept across reinstalls so paired phones keep working) ---------
if (-not (Test-Path $TokenPath)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [IO.File]::WriteAllText($TokenPath, $token)  # BOM-less, no trailing newline
    # Lock the token down with language-neutral SIDs (English names like
    # "Administrators" fail silently on localized Windows): S-1-5-18 SYSTEM,
    # S-1-5-32-544 Administrators, plus the installing user.
    icacls $TokenPath /inheritance:r /grant:r '*S-1-5-18:R' '*S-1-5-32-544:F' "$($env:USERNAME):R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed to restrict $TokenPath (exit $LASTEXITCODE)" }
    Write-Host "Created token: $TokenPath"
} else {
    $token = (Get-Content $TokenPath -Raw).Trim()
    Write-Host "Kept existing token: $TokenPath"
}

# --- 4. initial config (kept across reinstalls) -------------------------------
if (-not (Test-Path $ConfigPath)) {
    $config = [ordered]@{
        port  = $Port
        units = @(
            [ordered]@{ name = 'Audiosrv'; scope = 'system' }
        )
        actions = [ordered]@{
            'restart-explorer' = [ordered]@{
                label = 'Restart Explorer'
                description = 'Restart the Windows shell (explorer.exe), fixes a wedged desktop/taskbar'
                danger = 'medium'
                cmd = @('powershell','-NoProfile','-Command','Stop-Process -Name explorer -Force; Start-Process explorer.exe')
            }
            'lock' = [ordered]@{
                label = 'Lock Screen'; description = 'Lock the Windows session'
                danger = 'low'
                cmd = @('rundll32.exe','user32.dll,LockWorkStation')
            }
            'suspend' = [ordered]@{
                label = 'Suspend'
                description = 'Suspend the box to RAM; wake it from the app over Wake-on-LAN'
                danger = 'medium'
                cmd = @('rundll32.exe','powrprof.dll,SetSuspendState','0,1,0')
                detached = $true
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
    # Steam Client Service exists on any box with Steam: watch it too.
    if (Get-Service -Name 'Steam Client Service' -ErrorAction SilentlyContinue) {
        $config.units += [ordered]@{ name = 'Steam Client Service'; scope = 'system' }
    }
    $json = $config | ConvertTo-Json -Depth 6
    # WriteAllText writes BOM-less UTF-8. PS 5.1's `Set-Content -Encoding
    # utf8` prepends a BOM, which json.load rejects — the agent would then
    # silently fall back to its built-in defaults.
    [IO.File]::WriteAllText($ConfigPath, $json + "`n")
    Write-Host "Created config: $ConfigPath"
} else {
    Write-Host "Kept existing config: $ConfigPath"
    # Honor a port the user set in config.json for the firewall + pair URL
    # below (the task no longer passes --port, so config wins at runtime).
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

# --- 6. firewall (Private profile only: this is a LAN-only plain-HTTP agent) -
if (-not $NoFirewall) {
    Remove-NetFirewallRule -DisplayName $FwRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FwRule -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Write-Host "Firewall: allowed TCP $Port on the Private profile."
}

# --- 7. scheduled task: at logon, current user, interactive session ----------
# No --port argument: the agent reads the port from config.json, same as the
# Linux agent's systemd unit, so a config edit is honored after a restart.
if ($usePython) {
    $action = New-ScheduledTaskAction -Execute $pyPath `
        -Argument ('"{0}"' -f (Join-Path $InstallDir 'couchsided-win.py')) `
        -WorkingDirectory $InstallDir
} else {
    $action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'couchside-agent.exe') `
        -WorkingDirectory $InstallDir
}
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# RunLevel Limited (the default token): the agent must NOT run elevated.
# Everything it does (SendInput, ViGEm, shutdown/reboot/suspend/lock, sc
# query, event-log reads) works for a standard interactive user, and its
# token-authed action/launcher API must not execute LAN requests as admin.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
    -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' registered and started."

# --- 8. pairing ----------------------------------------------------------------
Write-Host ''
Write-Host '=========================================================='
Write-Host ' Couchside agent installed.'
Write-Host ''
Write-Host " Pair your phone: open  http://localhost:$Port/pair"
Write-Host ' on THIS machine and scan the QR with the Couchside app.'
Write-Host ''
Write-Host " Token file: $TokenPath"
Write-Host ' Gamepad: install ViGEmBus for the virtual controller:'
Write-Host '   https://github.com/nefarius/ViGEmBus/releases'
Write-Host '=========================================================='
# Best-effort: opening a URL needs an interactive session with a default
# browser; never let it fail the install (e.g. run over SSH / headless).
try { Start-Process "http://localhost:$Port/pair" -ErrorAction Stop } catch {
    Write-Host " (open the pairing page manually: http://localhost:$Port/pair)"
}
