const fs = require('fs');
const path = require('path');

const tradingRoutesPath = path.join(__dirname, 'src/routes/trading.routes.js');
const triangularRoutesPath = path.join(__dirname, 'src/routes/triangular-arb.routes.js');

console.log('Reading trading.routes.js...');
const content = fs.readFileSync(tradingRoutesPath, 'utf8');
const lines = content.split('\n');

// Find all triangular sections
const triangularSections = [
    'LUNO TRIANGULAR ARBITRAGE',
    'CHAINEX TRIANGULAR ARBITRAGE',
    'KRAKEN TRIANGULAR ARBITRAGE',
    'BYBIT TRIANGULAR ARBITRAGE',
    'BINANCE TRIANGULAR ARBITRAGE',
    'OKX TRIANGULAR ARBITRAGE',
    'KUCOIN TRIANGULAR ARBITRAGE',
    'COINBASE TRIANGULAR ARBITRAGE',
    'HUOBI (HTX) TRIANGULAR ARBITRAGE',
    'GATE.IO EXCHANGE - TRIANGULAR ARBITRAGE',
    'CRYPTO.COM EXCHANGE - TRIANGULAR ARBITRAGE',
    'MEXC EXCHANGE - TRIANGULAR ARBITRAGE',
    'XT TRIANGULAR ARBITRAGE',
    'ASCENDEX TRIANGULAR ARBITRAGE',
    'VALR TRIANGULAR ARBITRAGE'
];

let triangularLines = [];
let nonTriangularLines = [];
let inTriangularSection = false;
let currentSectionStart = -1;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if we're starting a triangular section
    const isTriangularStart = triangularSections.some(section => line.includes(section));

    if (isTriangularStart && !inTriangularSection) {
        inTriangularSection = true;
        currentSectionStart = i;
        console.log(`Found triangular section at line ${i + 1}: ${line.trim()}`);
    }

    // Check if we're ending a triangular section (next major section or end of file)
    const isSectionEnd = line.includes('// ============================================================================') &&
                        inTriangularSection &&
                        i > currentSectionStart + 10 &&
                        !triangularSections.some(section => line.includes(section));

    if (isSectionEnd) {
        console.log(`Triangular section ends at line ${i + 1}`);
        // Add the closing separator line to triangular
        triangularLines.push(line);
        inTriangularSection = false;
        currentSectionStart = -1;
        continue;
    }

    // Route the line to appropriate array
    if (inTriangularSection) {
        triangularLines.push(line);
    } else {
        nonTriangularLines.push(line);
    }
}

// Read the triangular template
const triangularTemplate = fs.readFileSync(triangularRoutesPath, 'utf8');
const templateLines = triangularTemplate.split('\n');

// Remove the last line (module.exports) from template
const templateWithoutExport = templateLines.slice(0, -1).join('\n');

// Add extracted triangular content
const finalTriangular = templateWithoutExport + '\n' + triangularLines.join('\n') + '\n\nmodule.exports = router;\n';

// Write the new triangular file
console.log('Writing triangular-arb.routes.js...');
fs.writeFileSync(triangularRoutesPath, finalTriangular);

// Write the cleaned trading.routes.js
console.log('Writing cleaned trading.routes.js...');
fs.writeFileSync(tradingRoutesPath, nonTriangularLines.join('\n'));

console.log('Split complete!');
console.log(`Triangular routes: ${triangularLines.length} lines`);
console.log(`Trading routes: ${nonTriangularLines.length} lines`);
