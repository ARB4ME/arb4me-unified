// Asset Declaration Service
// Manages user declarations of which fiat/stablecoins they have funded on each exchange

const AssetDeclaration = require('../../models/AssetDeclaration');
const Balance = require('../../models/Balance');
const { logger } = require('../../utils/logger');

class AssetDeclarationService {
    /**
     * Save user's asset declaration for an exchange
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name (VALR, Luno, Kraken, etc.)
     * @param {array} fundedAssets - Array of asset codes ["ZAR", "USDT", "USD"]
     * @param {object} initialBalances - Optional initial balances {"ZAR": 100000, "USDT": 5000}
     */
    static async saveDeclaration(userId, exchange, fundedAssets, initialBalances = {}) {
        try {
            logger.info(`Saving asset declaration for user ${userId} on ${exchange}`, {
                fundedAssets,
                hasInitialBalances: Object.keys(initialBalances).length > 0
            });

            // Validate inputs
            if (!fundedAssets || fundedAssets.length === 0) {
                throw new Error('Must declare at least one funded asset');
            }

            // Save declaration
            const declaration = await AssetDeclaration.saveDeclaration(
                userId,
                exchange,
                fundedAssets,
                initialBalances
            );

            // Initialize balance records for each asset
            for (const asset of fundedAssets) {
                const initialBalance = initialBalances[asset] || 0;

                // Create balance record
                await Balance.updateBalance(
                    userId,
                    exchange,
                    asset,
                    initialBalance, // available
                    0, // locked
                    'manual' // sync source (user declared, not API)
                );

                // Set initial balance for profit tracking
                if (initialBalance > 0) {
                    await Balance.setInitialBalance(userId, exchange, asset, initialBalance);
                }
            }

            logger.info(`Asset declaration saved for ${exchange}`, {
                userId,
                assetsCount: fundedAssets.length
            });

            return {
                success: true,
                declaration,
                message: `Successfully declared ${fundedAssets.length} asset(s) on ${exchange}`
            };

        } catch (error) {
            logger.error('Failed to save asset declaration', {
                userId,
                exchange,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get all asset declarations for a user
     * @param {number} userId - User ID
     * @param {boolean} activeOnly - Only return active declarations
     */
    static async getUserDeclarations(userId, activeOnly = true) {
        try {
            const declarations = await AssetDeclaration.getByUserId(userId, activeOnly);

            logger.info(`Retrieved asset declarations for user ${userId}`, {
                count: declarations.length
            });

            return declarations;

        } catch (error) {
            logger.error('Failed to get user declarations', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get declaration for specific exchange
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     */
    static async getExchangeDeclaration(userId, exchange) {
        try {
            const declaration = await AssetDeclaration.getByExchange(userId, exchange);

            return declaration;

        } catch (error) {
            logger.error('Failed to get exchange declaration', {
                userId,
                exchange,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get all funded assets across all exchanges
     * Returns organized structure for path generation
     */
    static async getAllFundedAssets(userId) {
        try {
            const result = await AssetDeclaration.getAllFundedAssets(userId);

            logger.info(`Retrieved all funded assets for user ${userId}`, {
                exchangesCount: Object.keys(result.byExchange).length,
                uniqueAssetsCount: result.uniqueAssets.length
            });

            return result;

        } catch (error) {
            logger.error('Failed to get all funded assets', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Delete asset declaration for an exchange
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     */
    static async deleteDeclaration(userId, exchange) {
        try {
            logger.info(`Deleting asset declaration for user ${userId} on ${exchange}`);

            const deleted = await AssetDeclaration.deleteDeclaration(userId, exchange);

            if (deleted) {
                logger.info(`Asset declaration deleted for ${exchange}`, { userId });
                return {
                    success: true,
                    message: `Successfully removed declaration for ${exchange}`
                };
            } else {
                return {
                    success: false,
                    message: `No declaration found for ${exchange}`
                };
            }

        } catch (error) {
            logger.error('Failed to delete asset declaration', {
                userId,
                exchange,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Update initial balances for profit tracking
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {object} initialBalances - Initial balances {"ZAR": 100000, "USDT": 5000}
     */
    static async updateInitialBalances(userId, exchange, initialBalances) {
        try {
            logger.info(`Updating initial balances for ${exchange}`, {
                userId,
                assets: Object.keys(initialBalances)
            });

            // Update declaration
            await AssetDeclaration.updateInitialBalances(userId, exchange, initialBalances);

            // Update balance records
            for (const [asset, amount] of Object.entries(initialBalances)) {
                await Balance.setInitialBalance(userId, exchange, asset, amount);
            }

            return {
                success: true,
                message: 'Initial balances updated successfully'
            };

        } catch (error) {
            logger.error('Failed to update initial balances', {
                userId,
                exchange,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Check if user has any declarations
     * Quick check to see if user has set up currency swap
     */
    static async hasDeclarations(userId) {
        try {
            return await AssetDeclaration.hasDeclarations(userId);

        } catch (error) {
            logger.error('Failed to check declarations', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get summary statistics for user's declarations
     * Useful for dashboard display
     */
    static async getDeclarationSummary(userId) {
        try {
            const declarations = await AssetDeclaration.getByUserId(userId, true);
            const fundedAssets = await AssetDeclaration.getAllFundedAssets(userId);

            const summary = {
                totalExchanges: declarations.length,
                exchanges: declarations.map(d => d.exchange),
                totalUniqueAssets: fundedAssets.uniqueAssets.length,
                uniqueAssets: fundedAssets.uniqueAssets,
                assetsByExchange: fundedAssets.byExchange,
                declarations: declarations
            };

            logger.info(`Generated declaration summary for user ${userId}`, {
                exchanges: summary.totalExchanges,
                assets: summary.totalUniqueAssets
            });

            return summary;

        } catch (error) {
            logger.error('Failed to get declaration summary', {
                userId,
                error: error.message
            });

            throw error;
        }
    }
}

module.exports = AssetDeclarationService;
