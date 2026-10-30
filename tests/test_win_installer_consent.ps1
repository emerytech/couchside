# Runs the real consent-write region against temporary config only.
param([string]$Source)
$ErrorActionPreference='Stop'
$text=Get-Content $Source -Raw
$a=$text.IndexOf('# Explicit opt-in/out;');$b=$text.IndexOf('# --- 5. hibernate',$a)
if ($a -lt 0 -or $b -lt 0) { throw 'Consent region missing' }
$code=[scriptblock]::Create($text.Substring($a,$b-$a))
$DataDir=Join-Path $env:TEMP ('couchside-consent-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $DataDir | Out-Null
$ConfigPath=Join-Path $DataDir 'config.json'
try {
 [IO.File]::WriteAllText($ConfigPath,'{"unknown":{"preserve":[1,2]},"allow_app_update":false}')
 $before=(Get-FileHash $ConfigPath).Hash
 $EnableUpdateCheck=$false;$DisableUpdateCheck=$false;& $code
 if ((Get-FileHash $ConfigPath).Hash -ne $before) { throw 'Omission changed config' }
 $EnableUpdateCheck=$true;& $code
 $obj=Get-Content $ConfigPath -Raw | ConvertFrom-Json
 if ($obj.allow_update_check -ne $true -or $obj.unknown.preserve.Count -ne 2 -or $obj.allow_app_update -ne $false) { throw 'Enable failed or unrelated state changed' }
 $EnableUpdateCheck=$false;$DisableUpdateCheck=$false;& $code
 if ((Get-Content $ConfigPath -Raw|ConvertFrom-Json).allow_update_check -ne $true) { throw 'Upgrade lost opt-in' }
 $DisableUpdateCheck=$true;& $code
 if ((Get-Content $ConfigPath -Raw|ConvertFrom-Json).allow_update_check -ne $false) { throw 'Disable failed' }
 if (@(Get-ChildItem $DataDir -Filter '*.tmp').Count -ne 0) { throw 'Stale temporary config' }
 'PASS: omission, explicit enable, upgrade preservation, explicit disable, unrelated keys, temporary cleanup'
} finally {Remove-Item $DataDir -Recurse -Force}
