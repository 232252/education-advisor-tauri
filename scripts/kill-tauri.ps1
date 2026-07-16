$ErrorActionPreference = 'SilentlyContinue'
# Kill Tauri and cargo processes
Get-Process -Name 'education-advisor-tauri' | Stop-Process -Force
Get-Process -Name 'cargo' | Stop-Process -Force
# Kill node processes on port 5173
$conns = Get-NetTCPConnection -LocalPort 5173
if ($conns) {
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
        if ($pid) { Stop-Process -Id $pid -Force }
    }
}
Start-Sleep -Seconds 2
Write-Output "Processes killed"

# Verify ports are free
$check5173 = Get-NetTCPConnection -LocalPort 5173
$check9222 = Get-NetTCPConnection -LocalPort 9222
Write-Output "Port 5173 in use: $($null -ne $check5173)"
Write-Output "Port 9222 in use: $($null -ne $check9222)"
