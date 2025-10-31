// Exchange Order Debug Utility
// Comprehensive logging for debugging exchange API integrations
// Enable with: MOMENTUM_DEBUG=true or per-exchange

const { logger } = require('./logger');

class ExchangeDebugger {
    constructor(exchange, enableForExchanges = ['chainex', 'kraken', 'binance']) {
        this.exchange = exchange.toLowerCase();
        this.enabled = process.env.MOMENTUM_DEBUG === 'true' ||
                      enableForExchanges.includes(this.exchange);
    }

    /**
     * Log comprehensive authentication debug info
     */
    logAuthentication(authDetails) {
        if (!this.enabled) return;

        console.error('\n' + '='.repeat(70));
        console.error(`🔍 ${this.exchange.toUpperCase()} ORDER AUTHENTICATION DEBUG`);
        console.error('='.repeat(70));

        // Request details
        console.error('\n📍 REQUEST DETAILS:');
        console.error('  Exchange:', this.exchange);
        console.error('  Method:', authDetails.method || 'POST');
        console.error('  Endpoint:', authDetails.endpoint);
        console.error('  Full URL:', authDetails.fullUrl || authDetails.endpoint);
        console.error('  Auth Type:', authDetails.authType || 'unknown');

        // Timing
        console.error('\n⏰ TIMING:');
        console.error('  Timestamp:', authDetails.timestamp);
        console.error('  Timestamp Type:', typeof authDetails.timestamp);
        console.error('  Current Time:', Date.now());
        console.error('  Time Format:', authDetails.timeFormat || 'unknown');

        // Credentials (masked)
        console.error('\n🔑 CREDENTIALS:');
        console.error('  API Key:', this.maskKey(authDetails.apiKey));
        console.error('  API Key Length:', authDetails.apiKey?.length || 0);
        console.error('  Has API Secret:', !!authDetails.apiSecret);
        console.error('  API Secret Length:', authDetails.apiSecret?.length || 0);

        // Signature details
        console.error('\n✍️  SIGNATURE:');
        console.error('  Signature Input:', authDetails.signatureInput);
        console.error('  Signature Method:', authDetails.signatureMethod || 'HMAC-SHA256');
        console.error('  Generated Signature:', authDetails.signature);
        console.error('  Signature Length:', authDetails.signature?.length || 0);

        // Headers
        if (authDetails.headers) {
            console.error('\n📋 HEADERS:');
            Object.entries(authDetails.headers).forEach(([key, value]) => {
                if (key.toLowerCase().includes('key') || key.toLowerCase().includes('signature')) {
                    console.error(`  ${key}:`, this.maskKey(value));
                } else {
                    console.error(`  ${key}:`, value);
                }
            });
        }

        // Query parameters
        if (authDetails.queryParams) {
            console.error('\n🔗 QUERY PARAMETERS:');
            Object.entries(authDetails.queryParams).forEach(([key, value]) => {
                if (key.toLowerCase().includes('key') || key.toLowerCase().includes('hash')) {
                    console.error(`  ${key}:`, this.maskKey(value));
                } else {
                    console.error(`  ${key}:`, value);
                }
            });
        }

        // Payload
        if (authDetails.payload) {
            console.error('\n📦 PAYLOAD:');
            console.error('  Body:', JSON.stringify(authDetails.payload, null, 2));
            console.error('  Body Length:', JSON.stringify(authDetails.payload).length);
        }

        console.error('\n' + '='.repeat(70) + '\n');
    }

    /**
     * Log response details
     */
    async logResponse(response, responseData) {
        if (!this.enabled) return;

        console.error('\n' + '='.repeat(70));
        console.error(`📥 ${this.exchange.toUpperCase()} ORDER RESPONSE`);
        console.error('='.repeat(70));

        console.error('\n📊 RESPONSE STATUS:');
        console.error('  Status Code:', response.status);
        console.error('  Status Text:', response.statusText);
        console.error('  OK:', response.ok);

        console.error('\n📋 RESPONSE HEADERS:');
        const headers = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        console.error(JSON.stringify(headers, null, 2));

        console.error('\n📦 RESPONSE BODY:');
        console.error(JSON.stringify(responseData, null, 2));

        console.error('\n' + '='.repeat(70) + '\n');
    }

    /**
     * Log comparison between implementations
     */
    logComparison(ourImpl, workingImpl) {
        if (!this.enabled) return;

        console.error('\n' + '='.repeat(70));
        console.error('🔬 IMPLEMENTATION COMPARISON');
        console.error('='.repeat(70));

        console.error('\n🆕 OUR IMPLEMENTATION:');
        console.error(JSON.stringify(ourImpl, null, 2));

        console.error('\n✅ WORKING IMPLEMENTATION:');
        console.error(JSON.stringify(workingImpl, null, 2));

        console.error('\n🔍 DIFFERENCES:');
        this.logDifferences(ourImpl, workingImpl);

        console.error('\n' + '='.repeat(70) + '\n');
    }

    /**
     * Log error details
     */
    logError(error, context) {
        if (!this.enabled) return;

        console.error('\n' + '='.repeat(70));
        console.error(`❌ ${this.exchange.toUpperCase()} ORDER ERROR`);
        console.error('='.repeat(70));

        console.error('\n🚨 ERROR DETAILS:');
        console.error('  Message:', error.message);
        console.error('  Type:', error.constructor.name);
        console.error('  Stack:', error.stack);

        if (context) {
            console.error('\n📍 ERROR CONTEXT:');
            console.error(JSON.stringify(context, null, 2));
        }

        console.error('\n' + '='.repeat(70) + '\n');
    }

    /**
     * Mask sensitive keys for logging
     */
    maskKey(key) {
        if (!key) return 'undefined';
        if (key.length <= 10) return '***';
        return key.substring(0, 8) + '...' + key.substring(key.length - 4);
    }

    /**
     * Find differences between objects
     */
    logDifferences(obj1, obj2, path = '') {
        const keys = new Set([...Object.keys(obj1 || {}), ...Object.keys(obj2 || {})]);

        keys.forEach(key => {
            const fullPath = path ? `${path}.${key}` : key;
            const val1 = obj1?.[key];
            const val2 = obj2?.[key];

            if (typeof val1 === 'object' && typeof val2 === 'object' && val1 !== null && val2 !== null) {
                this.logDifferences(val1, val2, fullPath);
            } else if (val1 !== val2) {
                console.error(`  ${fullPath}:`);
                console.error(`    Ours:   `, val1);
                console.error(`    Working:`, val2);
            }
        });
    }

    /**
     * Create a test summary
     */
    createTestSummary(exchange, authMethod, signaturePattern, pairs) {
        return {
            exchange: exchange,
            authMethod: authMethod,
            signaturePattern: signaturePattern,
            testPairs: pairs,
            timestamp: new Date().toISOString(),
            notes: 'Generated from successful implementation'
        };
    }
}

module.exports = ExchangeDebugger;
