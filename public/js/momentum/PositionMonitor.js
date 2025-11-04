// Position Monitor Service
// Monitors open positions and determines when to exit based on strategy rules
// Frontend version - converted from backend PositionMonitorService.js

const PositionMonitor = {
    /**
     * Monitor all open positions for a user
     * @param {string} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<Array>} Array of positions that were closed
     */
    async monitorPositions(userId, exchange, credentials) {
        try {
            // Get all open positions for user and exchange via API
            const response = await fetch(`/api/v1/momentum/positions?userId=${userId}&exchange=${exchange}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch open positions: ${response.statusText}`);
            }

            const result = await response.json();
            const openPositions = result.data?.open || [];

            console.log('📋 Position Monitor Check', {
                userId,
                exchange,
                totalOpen: openPositions.length,
                positions: openPositions.map(p => ({
                    id: p.id,
                    pair: p.pair,
                    entryTime: p.entry_time,
                    hoursOpen: ((Date.now() - new Date(p.entry_time).getTime()) / (1000 * 60 * 60)).toFixed(1)
                }))
            });

            if (!openPositions || openPositions.length === 0) {
                console.log('   ➜ No open positions to monitor');
                return [];
            }

            console.log(`   ➜ Checking ${openPositions.length} position(s) for exit conditions...`);

            const closedPositions = [];

            // Monitor each position
            for (const position of openPositions) {
                try {
                    console.log(`🔍 Checking position ${position.id} (${position.pair})...`);

                    const shouldClose = await this._checkExitConditions(
                        position,
                        exchange,
                        credentials
                    );

                    console.log(`   Decision: shouldExit=${shouldClose.shouldExit}, reason=${shouldClose.reason || 'none'}`);

                    if (shouldClose.shouldExit) {
                        // Execute exit order
                        console.log(`   ➜ Closing position ${position.id} due to ${shouldClose.reason}`);
                        const closedPosition = await this._closePosition(
                            position,
                            shouldClose.reason,
                            shouldClose.currentPrice,
                            exchange,
                            credentials
                        );

                        closedPositions.push(closedPosition);
                    } else {
                        console.log(`   ➜ Position ${position.id} does not meet exit conditions yet`);
                    }

                } catch (error) {
                    console.error(`❌ Failed to monitor position ${position.id}:`, {
                        positionId: position.id,
                        error: error.message,
                        stack: error.stack
                    });
                    // Continue monitoring other positions
                }
            }

            if (closedPositions.length > 0) {
                console.log('Positions closed', {
                    userId,
                    exchange,
                    closedCount: closedPositions.length
                });
            }

            return closedPositions;

        } catch (error) {
            console.error('Position monitoring failed', {
                userId,
                exchange,
                error: error.message
            });
            throw error;
        }
    },

    /**
     * Check exit conditions for a single position
     * @private
     * @param {object} position - Position object
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} {shouldExit, reason, currentPrice}
     */
    async _checkExitConditions(position, exchange, credentials) {
        try {
            // Get strategy configuration via API
            const strategyResponse = await fetch(`/api/v1/momentum/strategies/${position.strategy_id}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!strategyResponse.ok) {
                throw new Error(`Strategy not found: ${position.strategy_id}`);
            }

            const { data: strategy } = await strategyResponse.json();

            // Get current market price via API
            const priceResponse = await fetch('/api/v1/momentum/market/current-price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    exchange,
                    pair: position.pair,
                    credentials
                })
            });

            if (!priceResponse.ok) {
                throw new Error(`Failed to fetch current price: ${priceResponse.statusText}`);
            }

            const { data: currentPrice } = await priceResponse.json();

            // Use SignalDetection to check exit signals
            console.log('🔍 Checking exit signals with:', {
                positionId: position.id,
                pair: position.pair,
                entryTime: position.entry_time,
                currentPrice,
                exitRules: strategy.exit_rules,
                strategyId: strategy.id
            });

            const exitSignal = SignalDetection.checkExitSignals(
                position,
                currentPrice,
                strategy.exit_rules
            );

            console.log('📊 Exit signal result:', {
                positionId: position.id,
                shouldExit: exitSignal.shouldExit,
                reason: exitSignal.reason,
                details: exitSignal.details
            });

            return {
                ...exitSignal,
                currentPrice
            };

        } catch (error) {
            console.error('Failed to check exit conditions', {
                positionId: position.id,
                error: error.message
            });
            throw error;
        }
    },

    /**
     * Close a position by executing sell order
     * @private
     * @param {object} position - Position object
     * @param {string} reason - Exit reason
     * @param {number} currentPrice - Current market price
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} Closed position
     */
    /**
     * Helper: Fetch with timeout
     * @private
     */
    async _fetchWithTimeout(url, options, timeoutMs = 30000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${timeoutMs}ms`);
            }
            throw error;
        }
    },

    /**
     * Helper: Retry logic with exponential backoff
     * @private
     */
    async _retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (attempt < maxRetries) {
                    const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
                    console.warn(`Retry attempt ${attempt}/${maxRetries} after ${delay}ms`, {
                        error: error.message
                    });
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`All ${maxRetries} retry attempts failed`, {
                        error: error.message
                    });
                }
            }
        }

        throw lastError;
    },

    async _closePosition(position, reason, currentPrice, exchange, credentials) {
        let sellOrder = null;
        let exitPrice = null;
        let exitFee = null;

        try {
            console.log('🔐 Closing position', {
                positionId: position.id,
                pair: position.pair,
                reason,
                entryPrice: position.entry_price,
                currentPrice,
                quantity: position.entry_quantity
            });

            // STEP 1: Mark position as CLOSING to prevent duplicate sell attempts
            // This is CRITICAL - if sell succeeds but database update fails,
            // we won't retry the sell on an already-closed position
            console.log('🔒 STEP 1: Marking position as CLOSING...');
            const markClosingResponse = await this._fetchWithTimeout(
                `/api/v1/momentum/positions/${position.id}/mark-closing`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' }
                },
                10000 // 10 second timeout
            );

            if (!markClosingResponse.ok) {
                console.error('❌ Failed to mark position as CLOSING', {
                    positionId: position.id,
                    status: markClosingResponse.status
                });
                throw new Error(`Failed to mark position as CLOSING: ${markClosingResponse.statusText}`);
            }

            console.log('✅ Position marked as CLOSING', { positionId: position.id });

            // STEP 2: Execute market SELL order via API with increased timeout
            console.log('💰 STEP 2: Executing SELL order on exchange...');
            const orderResponse = await this._fetchWithTimeout(
                '/api/v1/momentum/order/sell',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exchange,
                        pair: position.pair,
                        quantity: position.entry_quantity,
                        credentials
                    })
                },
                60000 // 60 second timeout for exchange operations
            );

            if (!orderResponse.ok) {
                const errorText = await orderResponse.text();
                throw new Error(`Failed to execute sell order: ${orderResponse.status} - ${errorText}`);
            }

            const orderResult = await orderResponse.json();
            sellOrder = orderResult.data;

            // Extract sell order data
            exitPrice = sellOrder.executedPrice || currentPrice;
            const exitValue = sellOrder.executedValue || (exitPrice * position.entry_quantity);
            exitFee = sellOrder.fee || (exitValue * 0.001); // 0.1% conservative estimate

            console.log('✅ SELL order executed successfully', {
                positionId: position.id,
                exitPrice,
                exitValue,
                exitFee: exitFee.toFixed(4),
                orderId: sellOrder.orderId
            });

            // STEP 3: Update database with retry logic
            console.log('💾 STEP 3: Updating database (with retry)...');
            const closedPosition = await this._retryOperation(async () => {
                const closeResponse = await this._fetchWithTimeout(
                    `/api/v1/momentum/positions/${position.id}/close`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            exitPrice: exitPrice,
                            exitQuantity: position.entry_quantity,
                            exitFee: exitFee,
                            exitReason: reason,
                            exitOrderId: sellOrder.orderId
                        })
                    },
                    30000 // 30 second timeout for database update
                );

                if (!closeResponse.ok) {
                    const errorText = await closeResponse.text();
                    throw new Error(`Database update failed: ${closeResponse.status} - ${errorText}`);
                }

                const result = await closeResponse.json();
                return result.data;
            }, 3, 2000); // 3 retries, starting with 2 second delay

            console.log('✅ Position closed successfully with accurate P&L', {
                positionId: position.id,
                exitPrice,
                exitFee: exitFee.toFixed(4),
                entryFee: (position.entry_fee || 0).toFixed(4),
                netPnLUSDT: closedPosition.exit_pnl_usdt.toFixed(2),
                netPnLPercent: closedPosition.exit_pnl_percent.toFixed(2),
                reason
            });

            return closedPosition;

        } catch (error) {
            console.error('❌ CRITICAL: Failed to close position', {
                positionId: position.id,
                exchange,
                error: error.message,
                sellExecuted: sellOrder !== null,
                exitPrice,
                exitFee
            });

            // If sell succeeded but database update failed, log for reconciliation
            if (sellOrder !== null) {
                console.error('⚠️ RECONCILIATION NEEDED: Sell executed but database not updated', {
                    positionId: position.id,
                    exchange,
                    exitPrice,
                    exitFee,
                    orderId: sellOrder.orderId,
                    action: 'Position needs manual force-close in database'
                });
            }

            throw error;
        }
    },

    /**
     * Manually close a position (triggered by user)
     * @param {number} positionId - Position ID
     * @param {string} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} Closed position
     */
    async manualClosePosition(positionId, userId, exchange, credentials) {
        try {
            // Get position via API
            const positionResponse = await fetch(`/api/v1/momentum/positions/${positionId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!positionResponse.ok) {
                throw new Error(`Position not found: ${positionId}`);
            }

            const { data: position } = await positionResponse.json();

            if (position.user_id !== userId) {
                throw new Error('Unauthorized: Position does not belong to user');
            }

            if (position.status !== 'OPEN') {
                throw new Error('Position is already closed');
            }

            // Get current price via API
            const priceResponse = await fetch('/api/v1/momentum/market/current-price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    exchange,
                    pair: position.pair,
                    credentials
                })
            });

            if (!priceResponse.ok) {
                throw new Error(`Failed to fetch current price: ${priceResponse.statusText}`);
            }

            const { data: currentPrice } = await priceResponse.json();

            // Close the position
            const closedPosition = await this._closePosition(
                position,
                'manual_close',
                currentPrice,
                exchange,
                credentials
            );

            return closedPosition;

        } catch (error) {
            console.error('Manual close position failed', {
                positionId,
                userId,
                error: error.message
            });
            throw error;
        }
    },

    /**
     * Get current P&L for an open position
     * @param {number} positionId - Position ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} { currentPrice, currentValue, pnlUSDT, pnlPercent }
     */
    async getCurrentPnL(positionId, exchange, credentials) {
        try {
            // Get position via API
            const positionResponse = await fetch(`/api/v1/momentum/positions/${positionId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!positionResponse.ok) {
                throw new Error(`Position not found: ${positionId}`);
            }

            const { data: position } = await positionResponse.json();

            if (position.status !== 'OPEN') {
                throw new Error('Position is already closed');
            }

            // Get current price via API
            const priceResponse = await fetch('/api/v1/momentum/market/current-price', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    exchange,
                    pair: position.pair,
                    credentials
                })
            });

            if (!priceResponse.ok) {
                throw new Error(`Failed to fetch current price: ${priceResponse.statusText}`);
            }

            const { data: currentPrice } = await priceResponse.json();

            // Calculate current P&L
            const currentValue = currentPrice * position.entry_quantity;
            const pnlUSDT = currentValue - position.entry_value_usdt;
            const pnlPercent = (pnlUSDT / position.entry_value_usdt) * 100;

            const hoursOpen = (Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60);

            return {
                positionId: position.id,
                pair: position.pair,
                entryPrice: position.entry_price,
                entryValue: position.entry_value_usdt,
                currentPrice,
                currentValue,
                pnlUSDT,
                pnlPercent,
                hoursOpen: hoursOpen.toFixed(1)
            };

        } catch (error) {
            console.error('Get current P&L failed', {
                positionId,
                error: error.message
            });
            throw error;
        }
    }
};
