param([int]$TargetPid,[int]$Seconds,[string]$Root)
$ErrorActionPreference='Stop'
try {
if($Seconds -lt 1 -or $Seconds -gt 1800){throw 'Invalid bounded acceptance duration'}
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
if(!$parent -or $parent.Name -ne 'node.exe' -or $parent.CommandLine -notlike '*mc-autonomy-live.mjs*'){throw 'Acceptance process identity mismatch'}
$creation=$parent.CreationDate
@{ready=$true;pid=$TargetPid;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'watchdog-ready.json')
$deadline=(Get-Date).AddSeconds($Seconds)
while((Get-Date) -lt $deadline){
    if(Test-Path -LiteralPath (Join-Path $Root 'acceptance-stopped.json')){
        @{stopped=$true;forced=$false;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'watchdog.json')
        exit
    }
    Start-Sleep -Seconds 1
}
$current=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
$forced=$false
if($current -and $current.CreationDate -eq $creation -and $current.Name -eq 'node.exe' -and $current.CommandLine -like '*mc-autonomy-live.mjs*'){
    @{fired=$true;pid=$TargetPid;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'watchdog-fired.json')
    & taskkill.exe /PID $TargetPid /T /F | Out-Null
    $forced=$LASTEXITCODE -eq 0
}
@{stopped=(!$current -or $forced);forced=$forced;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'watchdog.json')
} catch {
    @{ready=$false;error=$_.Exception.GetType().Name;stage='watchdog_setup_or_check'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'watchdog-error.json')
    exit 1
}
