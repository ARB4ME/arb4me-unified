# Check Kraken position status in database

Write-Host "Checking all Kraken positions..." -ForegroundColor Yellow

# Get all positions (open, closing, closed) for Kraken
$response = Invoke-RestMethod -Uri "https://arb4me-unified-production.up.railway.app/api/v1/momentum/positions?userId=1&exchange=kraken" -Method Get

Write-Host "`nAll Kraken Positions:" -ForegroundColor Cyan
$response.data | ConvertTo-Json -Depth 10

Write-Host "`nOpen Positions:" -ForegroundColor Green
$response.data.open | ForEach-Object {
    Write-Host "  ID: $($_.id) | Pair: $($_.pair) | Status: $($_.status) | Entry: $($_.entry_time)"
}

Write-Host "`nClosed Positions:" -ForegroundColor Yellow
$response.data.closed | ForEach-Object {
    Write-Host "  ID: $($_.id) | Pair: $($_.pair) | Status: $($_.status) | Exit: $($_.exit_time)"
}
