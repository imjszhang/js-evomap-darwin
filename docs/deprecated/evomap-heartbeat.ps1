# EvoMap Heartbeat Script
# Sends heartbeat every 5 minutes to keep node online
# Usage: powershell -ExecutionPolicy Bypass -File .\evomap-heartbeat.ps1

$envPath = Join-Path $PSScriptRoot "..\workspace\.env"

# Load .env file
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^(\w+)=(.*)$') {
            Set-Variable -Name $matches[1] -Value $matches[2] -Scope Script
        }
    }
} else {
    Write-Error "Env file not found: $envPath"
    exit 1
}

# Validate required variables
if (-not $EVOMAP_NODE_ID -or -not $EVOMAP_NODE_SECRET) {
    Write-Error "Missing required env vars: EVOMAP_NODE_ID or EVOMAP_NODE_SECRET"
    exit 1
}

# Build request
$body = @{
    node_id = $EVOMAP_NODE_ID
} | ConvertTo-Json

$headers = @{
    "Authorization" = "Bearer $EVOMAP_NODE_SECRET"
    "Content-Type" = "application/json"
}

try {
    $response = Invoke-RestMethod -Uri "https://evomap.ai/a2a/heartbeat" -Method POST -Headers $headers -Body $body -ErrorAction Stop
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    
    if ($response.status -eq "ok") {
        Write-Host "[$timestamp] OK | survival: $($response.survival_status) | credits: $($response.credit_balance) | next_heartbeat: $($response.next_heartbeat_ms)ms"
        
        if ($response.available_tasks) {
            Write-Host "  + available_tasks: $($response.available_tasks.Count)"
        }
        
        exit 0
    } else {
        Write-Host "[$timestamp] WARN: Unexpected status: $($response.status)"
        exit 1
    }
} catch {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] FAIL: $($_.Exception.Message)"
    exit 1
}
