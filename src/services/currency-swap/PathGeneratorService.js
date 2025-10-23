// Path Generator Service
// Auto-generates ALL possible currency swap paths from user's selected exchanges + currencies (tickbox system)
// This is the "smart" feature that beats competitor platforms (no manual path creation)

const CurrencySwapSettings = require('../../models/CurrencySwapSettings');
const { logger } = require('../../utils/logger');

class PathGeneratorService {
    /**
     * Generate all possible swap paths for a user
     * @param {number} userId - User ID
     * @param {object} options - Filter options
     * @returns {array} Array of possible swap paths
     */
    static async generateAllPaths(userId, options = {}) {
        try {
            logger.info(`Generating swap paths for user ${userId}`);

            // Get user's settings (includes selected_exchanges and selected_currencies from tickboxes)
            const settings = await CurrencySwapSettings.getOrCreate(userId);

            // Parse selected exchanges and currencies from settings
            const selectedExchanges = typeof settings.selected_exchanges === 'string'
                ? JSON.parse(settings.selected_exchanges)
                : (settings.selected_exchanges || []);

            const selectedCurrencies = typeof settings.selected_currencies === 'string'
                ? JSON.parse(settings.selected_currencies)
                : (settings.selected_currencies || []);

            // Validate user has made selections
            if (selectedExchanges.length === 0 || selectedCurrencies.length === 0) {
                logger.warn(`User ${userId} has no selected exchanges or currencies`, {
                    exchanges: selectedExchanges.length,
                    currencies: selectedCurrencies.length
                });
                return [];
            }

            // Build assetsByExchange object (tickbox system: all selected currencies available on all selected exchanges)
            const assetsByExchange = {};
            selectedExchanges.forEach(exchange => {
                assetsByExchange[exchange] = [...selectedCurrencies]; // Each exchange gets all selected currencies
            });

            // Generate all possible paths
            const paths = this._generatePathCombinations(
                assetsByExchange,
                settings,
                options
            );

            logger.info(`Generated ${paths.length} possible swap paths`, {
                userId,
                exchanges: selectedExchanges.length,
                currencies: selectedCurrencies.length
            });

            return paths;

        } catch (error) {
            logger.error('Failed to generate swap paths', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Generate path combinations from funded assets
     * @private
     */
    static _generatePathCombinations(assetsByExchange, settings, options = {}) {
        const paths = [];
        const exchanges = Object.keys(assetsByExchange);

        // Bridge asset (XRP, USDT, or AUTO)
        const bridgeAsset = settings.preferred_bridge === 'AUTO'
            ? 'XRP'
            : settings.preferred_bridge;

        // Get enabled categories
        const enabledCategories = settings.enabled_categories || { ZAR: true, INTERNATIONAL: false };

        // For each source exchange
        for (const sourceExchange of exchanges) {
            const sourceAssets = assetsByExchange[sourceExchange];

            // For each destination exchange (different from source)
            for (const destExchange of exchanges) {
                if (destExchange === sourceExchange) continue;

                const destAssets = assetsByExchange[destExchange];

                // For each source asset
                for (const sourceAsset of sourceAssets) {
                    // For each destination asset (different from source)
                    for (const destAsset of destAssets) {
                        if (destAsset === sourceAsset) continue;

                        // Check category filters
                        if (!this._isAllowedByCategory(sourceAsset, destAsset, enabledCategories)) {
                            continue;
                        }

                        // Check allowed pairs
                        if (!this._isAllowedPair(sourceAsset, destAsset, settings.allowed_pairs)) {
                            continue;
                        }

                        // Create path object
                        const path = {
                            id: `${sourceExchange}-${sourceAsset}-${destExchange}-${destAsset}`,
                            sourceExchange,
                            sourceAsset,
                            destExchange,
                            destAsset,
                            bridgeAsset,

                            // Path description
                            description: `${sourceAsset} on ${sourceExchange} → ${destAsset} on ${destExchange} via ${bridgeAsset}`,

                            // Execution legs
                            legs: [
                                {
                                    leg: 1,
                                    action: 'buy',
                                    exchange: sourceExchange,
                                    pair: `${bridgeAsset}/${sourceAsset}`,
                                    side: 'buy',
                                    description: `Buy ${bridgeAsset} with ${sourceAsset} on ${sourceExchange}`
                                },
                                {
                                    leg: 2,
                                    action: 'transfer',
                                    fromExchange: sourceExchange,
                                    toExchange: destExchange,
                                    asset: bridgeAsset,
                                    description: `Transfer ${bridgeAsset} from ${sourceExchange} to ${destExchange}`
                                },
                                {
                                    leg: 3,
                                    action: 'sell',
                                    exchange: destExchange,
                                    pair: `${bridgeAsset}/${destAsset}`,
                                    side: 'sell',
                                    description: `Sell ${bridgeAsset} for ${destAsset} on ${destExchange}`
                                }
                            ]
                        };

                        paths.push(path);
                    }
                }
            }
        }

        return paths;
    }

    /**
     * Check if asset pair is allowed by category settings
     * @private
     */
    static _isAllowedByCategory(sourceAsset, destAsset, enabledCategories) {
        const zarAssets = ['ZAR'];
        const internationalAssets = ['USD', 'EUR', 'GBP', 'USDT', 'USDC'];

        // Check if it's a ZAR swap
        const isZARSwap = zarAssets.includes(sourceAsset) || zarAssets.includes(destAsset);

        // Check if it's an international swap
        const isInternationalSwap =
            internationalAssets.includes(sourceAsset) &&
            internationalAssets.includes(destAsset);

        // Apply category filters
        if (isZARSwap && !enabledCategories.ZAR) {
            return false;
        }

        if (isInternationalSwap && !enabledCategories.INTERNATIONAL) {
            return false;
        }

        return true;
    }

    /**
     * Check if asset pair is in allowed pairs list
     * @private
     */
    static _isAllowedPair(sourceAsset, destAsset, allowedPairs) {
        if (!allowedPairs || allowedPairs.length === 0) {
            return true; // No restrictions
        }

        // Check both directions
        const pair1 = `${sourceAsset}-${destAsset}`;
        const pair2 = `${destAsset}-${sourceAsset}`;

        return allowedPairs.includes(pair1) || allowedPairs.includes(pair2);
    }

    /**
     * Get paths filtered by specific criteria
     * @param {number} userId - User ID
     * @param {object} filters - Filter criteria
     */
    static async getFilteredPaths(userId, filters = {}) {
        try {
            // Generate all paths
            let paths = await this.generateAllPaths(userId);

            // Apply filters
            if (filters.sourceExchange) {
                paths = paths.filter(p => p.sourceExchange === filters.sourceExchange);
            }

            if (filters.destExchange) {
                paths = paths.filter(p => p.destExchange === filters.destExchange);
            }

            if (filters.sourceAsset) {
                paths = paths.filter(p => p.sourceAsset === filters.sourceAsset);
            }

            if (filters.destAsset) {
                paths = paths.filter(p => p.destAsset === filters.destAsset);
            }

            if (filters.bridgeAsset) {
                paths = paths.filter(p => p.bridgeAsset === filters.bridgeAsset);
            }

            logger.info(`Filtered paths: ${paths.length} results`, {
                userId,
                filters
            });

            return paths;

        } catch (error) {
            logger.error('Failed to get filtered paths', {
                userId,
                filters,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get paths grouped by exchange pair
     * Useful for UI display
     */
    static async getPathsByExchangePair(userId) {
        try {
            const paths = await this.generateAllPaths(userId);

            const grouped = {};

            paths.forEach(path => {
                const key = `${path.sourceExchange}-${path.destExchange}`;

                if (!grouped[key]) {
                    grouped[key] = {
                        sourceExchange: path.sourceExchange,
                        destExchange: path.destExchange,
                        paths: []
                    };
                }

                grouped[key].paths.push(path);
            });

            return grouped;

        } catch (error) {
            logger.error('Failed to group paths by exchange', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Get path statistics for user
     * Useful for dashboard display
     */
    static async getPathStatistics(userId) {
        try {
            const paths = await this.generateAllPaths(userId);

            // Get user's settings for selected exchanges and currencies
            const settings = await CurrencySwapSettings.getOrCreate(userId);

            const selectedExchanges = typeof settings.selected_exchanges === 'string'
                ? JSON.parse(settings.selected_exchanges)
                : (settings.selected_exchanges || []);

            const selectedCurrencies = typeof settings.selected_currencies === 'string'
                ? JSON.parse(settings.selected_currencies)
                : (settings.selected_currencies || []);

            const stats = {
                totalPaths: paths.length,
                totalExchanges: selectedExchanges.length,
                totalAssets: selectedCurrencies.length,

                // Count by source exchange
                bySourceExchange: {},

                // Count by destination exchange
                byDestExchange: {},

                // Count by asset pair
                byAssetPair: {}
            };

            paths.forEach(path => {
                // By source exchange
                stats.bySourceExchange[path.sourceExchange] =
                    (stats.bySourceExchange[path.sourceExchange] || 0) + 1;

                // By dest exchange
                stats.byDestExchange[path.destExchange] =
                    (stats.byDestExchange[path.destExchange] || 0) + 1;

                // By asset pair
                const pairKey = `${path.sourceAsset}-${path.destAsset}`;
                stats.byAssetPair[pairKey] =
                    (stats.byAssetPair[pairKey] || 0) + 1;
            });

            logger.info(`Generated path statistics for user ${userId}`, stats);

            return stats;

        } catch (error) {
            logger.error('Failed to get path statistics', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Validate a specific path
     * Checks if path is valid based on current declarations
     */
    static async validatePath(userId, pathId) {
        try {
            const paths = await this.generateAllPaths(userId);
            const path = paths.find(p => p.id === pathId);

            if (!path) {
                return {
                    valid: false,
                    error: 'Path not found or no longer valid'
                };
            }

            return {
                valid: true,
                path
            };

        } catch (error) {
            logger.error('Failed to validate path', {
                userId,
                pathId,
                error: error.message
            });

            throw error;
        }
    }
}

module.exports = PathGeneratorService;
