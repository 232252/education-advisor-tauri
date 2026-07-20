@echo off
chcp 65001 >nul
REM ============================================================
REM Education Advisor 启动诊断脚本 (v0.1.2+)
REM 双击运行,会把诊断信息写到桌面 diagnose-result.txt
REM 用途: 应用打不开/白屏时收集环境信息
REM ============================================================

set "OUT=%USERPROFILE%\Desktop\diagnose-result.txt"
echo Education Advisor 启动诊断 - %date% %time% > "%OUT%"
echo ================================================== >> "%OUT%"
echo.

REM 1. 操作系统版本
echo [1/6] 操作系统 >> "%OUT%"
ver >> "%OUT%" 2>&1
powershell -NoProfile -Command "(Get-WmiObject Win32_OperatingSystem).Caption + ' Build ' + (Get-WmiObject Win32_OperatingSystem).BuildNumber" >> "%OUT%" 2>&1
echo. >> "%OUT%"

REM 2. WebView2 Runtime
echo [2/6] WebView2 Runtime >> "%OUT%"
set "WV2_FOUND=0"
for /f "tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv 2^>nul') do (
    set "WV2_FOUND=1"
    echo   HKLM: %%b >> "%OUT%"
)
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv 2^>nul') do (
    set "WV2_FOUND=1"
    echo   HKCU: %%b >> "%OUT%"
)
if "%WV2_FOUND%"=="0" (
    echo   *** WebView2 Runtime 未安装! 这是白屏最常见原因 *** >> "%OUT%"
    echo   下载安装: https://go.microsoft.com/fwlink/p/?LinkId=212470 >> "%OUT%"
) else (
    echo   WebView2 Runtime 已安装 >> "%OUT%"
)
echo. >> "%OUT%"

REM 3. 安装位置
echo [3/6] 安装位置 >> "%OUT%"
set "INSTALL_DIR=%LOCALAPPDATA%\Education Advisor"
if exist "%INSTALL_DIR%\education-advisor-tauri.exe" (
    echo   已安装: %INSTALL_DIR% >> "%OUT%"
    powershell -NoProfile -Command "(Get-Item '%INSTALL_DIR%\education-advisor-tauri.exe').VersionInfo | Select-Object FileVersion, ProductVersion, LastWriteTime | Format-List" >> "%OUT%" 2>&1
) else (
    echo   *** 未找到 %INSTALL_DIR% *** >> "%OUT%"
)
echo. >> "%OUT%"

REM 4. 残留进程
echo [4/6] 残留进程 >> "%OUT%"
tasklist 2>nul | findstr /i "education" >> "%OUT%"
if errorlevel 1 echo   (无残留进程) >> "%OUT%"
echo. >> "%OUT%"

REM 5. 启动应用 + 捕获早期 stderr
echo [5/6] 启动应用 ^& 捕获输出 (8秒后强杀) >> "%OUT%"
set "EXE=%INSTALL_DIR%\education-advisor-tauri.exe"
if not exist "%EXE%" (
    echo   *** exe 不存在: %EXE% *** >> "%OUT%"
    goto logs
)

REM 用 PowerShell 启动,捕获退出码和 stderr,8 秒后强杀
powershell -NoProfile -Command ^
    "$p = Start-Process -FilePath '%EXE%' -PassThru -RedirectStandardError '%USERPROFILE%\Desktop\stderr.txt' -RedirectStandardOutput '%USERPROFILE%\Desktop\stdout.txt';" ^
    "Start-Sleep -Seconds 8;" ^
    "if ($p.HasExited) { Write-Host ('EXITED code=' + $p.ExitCode) } else { Write-Host ('RUNNING PID=' + $p.Id); Stop-Process -Id $p.Id -Force }" >> "%OUT%" 2>&1

echo. >> "%OUT%"
echo --- stderr: --- >> "%OUT%"
if exist "%USERPROFILE%\Desktop\stderr.txt" type "%USERPROFILE%\Desktop\stderr.txt" >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo --- stdout: --- >> "%OUT%"
if exist "%USERPROFILE%\Desktop\stdout.txt" type "%USERPROFILE%\Desktop\stdout.txt" >> "%OUT%" 2>&1
echo. >> "%OUT%"

:logs
REM 6. 应用日志
echo [6/6] 应用日志 (今天的) >> "%OUT%"
set "LOGDIR=%APPDATA%\com.educationadvisor.tauri\logs"
if exist "%LOGDIR%" (
    powershell -NoProfile -Command "Get-ChildItem '%LOGDIR%' -Filter '*$(Get-Date -Format yyyy-MM-dd)*' | ForEach-Object { Write-Host ('--- ' + $_.Name + ' ---'); Get-Content $_.FullName -Tail 50; Write-Host '' }" >> "%OUT%" 2>&1
) else (
    echo   日志目录不存在: %LOGDIR% >> "%OUT%"
)
echo. >> "%OUT%"

echo ================================================== >> "%OUT%"
echo 诊断完成! 结果已写到桌面: %OUT% >> "%OUT%"
echo.
echo 诊断完成! 请把桌面上的 diagnose-result.txt 发给我。
echo 同时请把 stderr.txt 和 stdout.txt 也一起发(如果有的话)。
pause
