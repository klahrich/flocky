param(
  [Parameter(Mandatory=$true)][string]$TaskName,
  [Parameter(Mandatory=$true)][string]$ProjectPath,
  [Parameter(Mandatory=$true)][string]$JobId,
  [Parameter(Mandatory=$true)][string[]]$AtLocalTime,
  [switch]$Apply
)
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $ProjectPath 'tools\flocky-schedule.mjs'
if (!(Test-Path $runner)) { throw "Flocky runner not found: $runner" }
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --cwd "{1}" --job "{2}"' -f $runner,$ProjectPath,$JobId)
$triggers = @($AtLocalTime | ForEach-Object { New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($_,'HH:mm',$null)) })
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
if (!$Apply) { Write-Output "Preview only. Would install $TaskName at $($AtLocalTime -join ', ') local time."; exit 0 }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "Installed $TaskName"
