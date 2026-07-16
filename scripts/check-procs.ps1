$ErrorActionPreference = 'SilentlyContinue'
Write-Output "=== Process Check ==="
$procs = Get-Process | Where-Object { $_.ProcessName -match 'tauri|education|node|eaa|cargo' }
if ($procs) {
    $procs | Select-Object ProcessName, Id, StartTime | Format-Table -AutoSize
} else {
    Write-Output "No matching processes found"
}
Write-Output "=== Port 5173 ==="
$conn = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
if ($conn) {
    $conn | Select-Object LocalPort, State, OwningProcess | Format-Table -AutoSize
} else {
    Write-Output "Port 5173 not in use"
}
Write-Output "=== Port 9222 ==="
$conn2 = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue
if ($conn2) {
    $conn2 | Select-Object LocalPort, State, OwningProcess | Format-Table -AutoSize
} else {
    Write-Output "Port 9222 not in use"
}
