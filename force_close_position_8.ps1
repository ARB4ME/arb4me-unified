# Force close Position 8 (Binance XRP)
# Position 8 cannot auto-close due to max hold time not configured
# Manual close fails due to Binance LOT_SIZE filter on quantity 4.1 XRP

# Get current XRP price from Binance
$binancePrice = (Invoke-RestMethod -Uri "https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT").price
Write-Host "Current XRP price on Binance: $binancePrice USDT" -ForegroundColor Cyan

# Position 8 details from database
$entryPrice = 2.41060000
$entryQuantity = 4.1000
$entryValue = 9.88  # $2.41060000 * 4.1

# Calculate exit values
$exitPrice = [decimal]$binancePrice
$exitQuantity = 4.1000
$exitValue = $exitPrice * $exitQuantity
$exitFee = $exitValue * 0.001  # 0.1% Binance taker fee estimate

# Calculate P&L
$pnl = ($exitValue - $exitFee) - $entryValue
$pnlPercent = ($pnl / $entryValue) * 100

$body = @{
    exitPrice = $exitPrice
    exitQuantity = $exitQuantity
    exitFee = $exitFee
    exitTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    exitReason = "manual_close_lot_size_issue"
    exitPnlUsdt = [math]::Round($pnl, 2)
    exitPnlPercent = [math]::Round($pnlPercent, 2)
} | ConvertTo-Json

Write-Host "`nForce closing Position 8..." -ForegroundColor Yellow
Write-Host "Entry: $entryQuantity XRP @ `$$entryPrice = `$$entryValue USDT" -ForegroundColor Gray
Write-Host "Exit: $exitQuantity XRP @ `$$exitPrice = `$$([math]::Round($exitValue, 2)) USDT" -ForegroundColor Gray
Write-Host "Fee: `$$([math]::Round($exitFee, 4)) USDT" -ForegroundColor Gray
Write-Host "P&L: `$$([math]::Round($pnl, 2)) USDT ($([math]::Round($pnlPercent, 2))%)" -ForegroundColor $(if ($pnl -gt 0) { "Green" } else { "Red" })

$response = Invoke-RestMethod -Uri "https://arb4me-unified-production.up.railway.app/api/v1/momentum/positions/8/force-close" `
    -Method Put `
    -Body $body `
    -ContentType "application/json"

Write-Host "`nResponse:" -ForegroundColor Green
$response | ConvertTo-Json -Depth 10

Write-Host "`nPosition 8 force-closed successfully!" -ForegroundColor Green
Write-Host "Note: XRP still on Binance exchange - you'll need to manually sell 4.1 XRP via Binance website/app" -ForegroundColor Yellow
