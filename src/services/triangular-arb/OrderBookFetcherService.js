/**
 * Order Book Fetcher Service
 * Fetches order books from exchanges with proper authentication
 *
 * IMPORTANT: Stateless - credentials passed as parameters
 * Acts as CORS proxy, formatting requests per exchange specification
 */

const { systemLogger } = require('../../utils/logger');
const ExchangeConnectorService = require('./ExchangeConnectorService');

class OrderBookFetcherService {
    constructor() {
        this.exchangeConnector = new ExchangeConnectorService();
    }

    /**
     * Fetch multiple order books for an exchange
     * @param {string} exchange - Exchange name
     * @param {array} pairs - Array of trading pairs
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
     * @returns {Promise<object>} Order books mapped by pair
     */
    async fetchMultiple(exchange, pairs, credentials) {
        systemLogger.trading(`Fetching ${pairs.length} order books from ${exchange}`);

        try {
            // Fetch all order books in parallel
            const fetchPromises = pairs.map(pair =>
                this._fetchSingle(exchange, pair, credentials)
                    .then(orderBook => ({ pair, orderBook, error: null }))
                    .catch(error => ({ pair, orderBook: null, error: error.message }))
            );

            const results = await Promise.all(fetchPromises);

            // Build order book map
            const orderBooks = {};
            let successCount = 0;
            let errorCount = 0;

            for (const result of results) {
                if (result.error) {
                    systemLogger.warn(`Failed to fetch order book for ${result.pair}`, {
                        exchange,
                        error: result.error
                    });
                    errorCount++;
                } else {
                    orderBooks[result.pair] = result.orderBook;
                    successCount++;
                }
            }

            systemLogger.trading(`Order book fetch complete`, {
                exchange,
                success: successCount,
                errors: errorCount,
                total: pairs.length
            });

            if (successCount === 0) {
                throw new Error(`Failed to fetch any order books from ${exchange}`);
            }

            return orderBooks;

        } catch (error) {
            systemLogger.error(`Order book fetch failed`, {
                exchange,
                pairs: pairs.length,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch single order book
     * @private
     */
    async _fetchSingle(exchange, pair, credentials) {
        try {
            // Use exchange connector to fetch with proper auth
            const orderBook = await this.exchangeConnector.fetchOrderBook(
                exchange,
                pair,
                credentials  // Pass credentials through
            );

            return orderBook;

        } catch (error) {
            systemLogger.error(`Failed to fetch order book`, {
                exchange,
                pair,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = OrderBookFetcherService;
