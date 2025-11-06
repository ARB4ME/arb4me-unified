/**
 * Check VALR positions to see if any are stuck OPEN/CLOSING
 * This will help identify the ~39 USDT reserved discrepancy
 */

const { query } = require('./src/database/connection');

async function checkValrPositions() {
    try {
        console.log('✅ Checking VALR positions in database\n');

        // Check for any OPEN or CLOSING positions on VALR
        const openPositions = await query(`
            SELECT id, pair, status, entry_time, exit_time, entry_value_usdt, entry_quantity, exit_pnl_usdt
            FROM positions
            WHERE exchange = 'valr'
              AND status IN ('OPEN', 'CLOSING')
              AND user_id = 1
            ORDER BY entry_time DESC
        `);

        console.log('🔍 OPEN/CLOSING POSITIONS ON VALR:');
        console.log('=' .repeat(80));

        if (openPositions.length === 0) {
            console.log('✅ No open or closing positions found');
        } else {
            console.log(`⚠️  Found ${openPositions.length} position(s) that may be stuck:\n`);
            openPositions.forEach(pos => {
                const hoursOpen = pos.entry_time
                    ? Math.round((Date.now() - new Date(pos.entry_time).getTime()) / (1000 * 60 * 60))
                    : 'N/A';

                console.log(`Position ID: ${pos.id}`);
                console.log(`  Pair: ${pos.pair}`);
                console.log(`  Status: ${pos.status}`);
                console.log(`  Entry Time: ${pos.entry_time}`);
                console.log(`  Exit Time: ${pos.exit_time || 'Not exited'}`);
                console.log(`  Entry Value: ${pos.entry_value_usdt} USDT`);
                console.log(`  Hours Open: ${hoursOpen}h`);
                console.log('');
            });

            // Calculate total USDT locked
            const totalLocked = openPositions.reduce((sum, pos) => sum + parseFloat(pos.entry_value_usdt || 0), 0);
            console.log(`💰 Total USDT potentially locked: ${totalLocked.toFixed(2)} USDT`);
        }

        console.log('\n' + '='.repeat(80));

        // Check all recent VALR positions (last 7 days)
        const recentPositions = await query(`
            SELECT id, pair, status, entry_time, exit_time, entry_value_usdt, exit_pnl_usdt
            FROM positions
            WHERE exchange = 'valr'
              AND user_id = 1
              AND entry_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            ORDER BY entry_time DESC
        `);

        console.log('\n📊 ALL RECENT VALR POSITIONS (Last 7 days):');
        console.log('=' .repeat(80));
        console.log(`Total positions: ${recentPositions.length}\n`);

        const statusCounts = {};
        recentPositions.forEach(pos => {
            statusCounts[pos.status] = (statusCounts[pos.status] || 0) + 1;
        });

        console.log('Status breakdown:');
        Object.entries(statusCounts).forEach(([status, count]) => {
            console.log(`  ${status}: ${count}`);
        });

        console.log('\nRecent positions detail:');
        recentPositions.forEach(pos => {
            console.log(`  ${pos.id} | ${pos.pair} | ${pos.status} | Entry: ${pos.entry_time} | Exit: ${pos.exit_time || 'N/A'}`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

// Run the check
checkValrPositions();
