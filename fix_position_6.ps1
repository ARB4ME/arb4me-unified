# PowerShell script to fix position 6
# Based on actual VALR transaction: Sold 4.085400 XRP for 9.342945 USDT on 04 Nov 2025 07:36

$body = @{
    exitPrice = 2.288
    exitQuantity = 4.085400
    exitFee = 0.009343
    exitTime = "2025-11-04T07:36:00Z"
    exitReason = "max_hold_time"
    exitPnlUsdt = -0.657
    exitPnlPercent = -6.57
} | ConvertTo-Json

Write-Host "Fixing position 6..." -ForegroundColor Yellow
Write-Host "Data from VALR transaction history:" -ForegroundColor Cyan
Write-Host $body

$response = Invoke-RestMethod -Uri "https://arb4me-unified-production.up.railway.app/api/v1/momentum/positions/6/force-close" `
    -Method Put `
    -Body $body `
    -ContentType "application/json"

Write-Host "`nResponse:" -ForegroundColor Green
$response | ConvertTo-Json -Depth 10

Write-Host "`nPosition 6 fixed!" -ForegroundColor Green
Write-Host "- Removed from Open Positions" -ForegroundColor Yellow
Write-Host "- Added to Recent Closed Positions" -ForegroundColor Yellow
