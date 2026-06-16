Start-Transcript -Path "$env:USERPROFILE\qwen-gate\startup.log" -Append

$ServerDir = "$env:USERPROFILE\qwen-gate\qwen-gate-latest"
$NodeExe = "node"
$Entry = "$ServerDir\src\index.tsx"
$Port = 26405

Write-Host "[$(Get-Date)] Starting qwen-gate server..."

# Kill any existing server on port
$existingProc = netstat -ano | Select-String ":$Port\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($existingProc -and $existingProc -ne '0') {
    Write-Host "[$(Get-Date)] Port $Port in use by PID $existingProc - killing..."
    Stop-Process -Id $existingProc -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Verify Playwright browsers exist
$playwrightPath = "$env:LOCALAPPDATA\ms-playwright"
if (-not (Test-Path $playwrightPath) -or (Get-ChildItem $playwrightPath -ErrorAction SilentlyContinue).Count -eq 0) {
    Write-Host "[$(Get-Date)] Playwright browsers not found - installing..."
    Set-Location $ServerDir
    npx playwright install 2>&1 | Write-Host
}

# Start server loop (restart on crash)
$env:HOST = "0.0.0.0"
while ($true) {
    # Pre-check port availability
    $portInUse = netstat -ano | Select-String ":$Port\s+.*LISTENING"
    if ($portInUse) {
        $blockingPid = ($portInUse -split '\s+')[-1]
        Write-Host "[$(Get-Date)] Port $Port still in use by PID $blockingPid - killing..."
        Stop-Process -Id $blockingPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    Write-Host "[$(Get-Date)] Starting server..."
    $proc = Start-Process -FilePath $NodeExe -ArgumentList "--import","tsx",$Entry -WorkingDirectory $ServerDir -PassThru -NoNewWindow -RedirectStandardOutput "$env:USERPROFILE\qwen-gate\server-stdout.log" -RedirectStandardError "$env:USERPROFILE\qwen-gate\server-stderr.log"
    Write-Host "[$(Get-Date)] Server started (PID: $($proc.Id))"
    
    # Wait for server to exit
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    
    # Check stderr for crash details
    $stderrContent = Get-Content "$env:USERPROFILE\qwen-gate\server-stderr.log" -ErrorAction SilentlyContinue
    if ($stderrContent) {
        Write-Host "[$(Get-Date)] Server crashed with errors:"
        $stderrContent | Select-Object -First 10 | Write-Host
    }
    
    Write-Host "[$(Get-Date)] Server exited with code $exitCode - restarting in 5s..."
    Start-Sleep -Seconds 5
}
