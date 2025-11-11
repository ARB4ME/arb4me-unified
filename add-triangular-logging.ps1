# PowerShell script to add trade logging to all Triangular ARB execute functions
# This adds logTriangularTrade() calls after each successful trade execution

$file = "C:\Users\Jonathan\OneDrive\Documents\Work\JONO WORK\AIM Arbitrage\2023\IDATCO\ARB4ME\arb4me-unified\public\triangular-arb.html"
$content = Get-Content $file -Raw

# Define the exchanges and their logging patterns
$exchanges = @(
    @{
        Name = "VALR"
        SearchPattern = "showNotification\(`Trade executed! Profit: \`\$\`\$\{data.profit.toFixed\(2\)\} \(\`\$\{data.profitPercentage\}%\)\`, 'success'\);\s+// Refresh"
        Replacement = "showNotification(`Trade executed! Profit: `$`${data.profit.toFixed(2)} (`${data.profitPercentage}%)``, 'success');

                    // 📊 Log to backend using shared service
                    logTriangularTrade('VALR', opportunity.pathId, data.profit || 0, maxInvestment, data.fees || 0).catch(e => console.warn('Logging failed:', e));

                    // Refresh"
    },
    @{
        Name = "MEXC"
        SearchPattern = "alert\(`✅ MEXC Trade Executed!.*?\);\s+loadMexcTradeHistory\(\);"
        Replacement = "alert(`✅ MEXC Trade Executed!\n\nPath: `${opportunity.path.join(' → ')}\nActual Profit: `${result.actualProfitZAR} USDT (`${result.actualProfitPercent}%)\nExecution Time: `${result.executionTime}ms\n\nTrade ID: `${result.tradeId}`);

                    // 📊 Log to backend
                    logTriangularTrade('MEXC', opportunity.path ? opportunity.path.join('→') : 'MEXC_PATH', result.actualProfitZAR || 0, opportunity.investmentAmount || 0, result.fees || 0).catch(e => console.warn('Logging failed:', e));

                    loadMexcTradeHistory();"
    }
)

Write-Host "This script needs to be customized for each exchange's unique success pattern." -ForegroundColor Yellow
Write-Host "For now, manual editing is more reliable for the Triangular ARB file." -ForegroundColor Yellow
Write-Host "Please use the Edit tool instead to add logging systematically." -ForegroundColor Cyan
