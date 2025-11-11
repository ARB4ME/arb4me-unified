# Force close stuck position 9 on VALR
$body = @{
    exitPrice = 2.287
    exitQuantity = 4.0854
    exitTime = "2025-11-04T07:36:00.000Z"
    exitReason = "manual_recovery_overselling_bug"
    exitPnlUsdt = -0.66
    exitPnlPercent = -6.6
    exitFee = 0.01
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://arb4me-unified-production.up.railway.app/api/v1/momentum/positions/9/force-close" `
    -Method PUT `
    -Body $body `
    -ContentType "application/json"

Write-Host "Response:" -ForegroundColor Green
$response | ConvertTo-Json -Depth 10
