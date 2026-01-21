const BfmrClient = require('./bfmr-client');
const DealManager = require('./deal-manager');
const AmazonBuyer = require('./buyer/amazon');
const BfmrWeb = require('./buyer/bfmr-web');
const AmazonOrderTracker = require('./tracker/amazon-order-tracker');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

class Monitor {
    constructor() {
        this.bfmrClient = new BfmrClient();
        this.amazonBuyer = new AmazonBuyer();
        this.bfmrWeb = new BfmrWeb();
        this.dealManager = new DealManager(this.bfmrClient, this.bfmrWeb);
        this.amazonTracker = new AmazonOrderTracker(this);
        this.isRunning = false;
        this.isChecking = false; // Prevent concurrent check runs
        this.isSyncing = false;
        this.config = this.loadConfig();
        this.intervalId = null;
        this.syncIntervalId = null;
    }

    loadConfig() {
        try {
            const configPath = path.join(__dirname, '..', 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(configData);
        } catch (error) {
            return { polling_interval_minutes: 5, dry_run: true };
        }
    }

    async start() {
        if (this.isRunning) {
            logger.log('Monitor is already running', 'WARN');
            return;
        }

        this.isRunning = true;
        logger.log('🚀 BFMR Auto-Buyer Monitor started');
        logger.log(`Polling interval: ${this.config.polling_interval_minutes} minutes`);
        logger.log(`Dry run mode: ${this.config.dry_run ? 'ON' : 'OFF'}`);

        // Start auto-polling if configured
        if (this.config.auto_mode !== false) {
            this.startPolling();
        } else {
            logger.log('Starting in MANUAL mode (auto-polling disabled)');
        }

        // Start order sync polling if configured
        if (this.config.sync_orders && this.config.sync_orders.enabled) {
            this.startSyncPolling();
        }
    }

    startPolling() {
        if (this.intervalId) return;

        logger.log('🔄 Auto-polling enabled');
        // Run immediately
        this.checkDeals();

        // Then run on interval
        const intervalMs = this.config.polling_interval_minutes * 60 * 1000;
        this.intervalId = setInterval(() => this.checkDeals(), intervalMs);
    }

    startSyncPolling() {
        if (this.syncIntervalId) return;

        const intervalMins = this.config.sync_orders?.interval_minutes || 30;
        logger.log(`📦 Auto-sync enabled (Every ${intervalMins} mins)`);

        // Don't run immediately on start to avoid getting in the way of deal checking
        // Wait 1 minute before first sync
        setTimeout(() => this.syncOrders(), 60000);

        const intervalMs = intervalMins * 60 * 1000;
        this.syncIntervalId = setInterval(() => this.syncOrders(), intervalMs);
    }

    async syncOrders(isManual = false) {
        if (this.isSyncing) {
            logger.log('⚠️ Order sync already in progress, skipping...', 'WARN');
            return;
        }

        this.isSyncing = true;
        try {
            await this.amazonTracker.sync(isManual);
        } catch (error) {
            logger.log(`Error syncing orders: ${error.message}`, 'ERROR');
        } finally {
            this.isSyncing = false;
        }
    }

    stopPolling() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.log('⏸️ Auto-polling disabled');
        }
    }

    setAutoMode(enabled) {
        if (enabled) {
            this.startPolling();
        } else {
            this.stopPolling();
        }
    }

    async runOnce() {
        logger.log('👉 Manual check triggered');
        await this.checkDeals();
    }

    async checkDeals() {
        // Prevent concurrent runs
        if (this.isChecking) {
            logger.log('⚠️ Check already in progress, skipping...', 'WARN');
            return;
        }

        this.isChecking = true;

        try {
            // Check login status first
            const isLoggedIn = await this.amazonBuyer.checkLoginStatus();
            if (!isLoggedIn) {
                logger.log('❌ Not logged in to Amazon! Stopping monitor.', 'ERROR');
                this.stop(); // Stop the monitor
                return;
            }

            logger.log('🔍 Checking for new deals...');
            const deals = await this.dealManager.fetchAndFilterDeals();

            if (deals.length === 0) {
                logger.log('No actionable deals found');
                return;
            }

            logger.log(`Found ${deals.length} actionable deal(s)`);

            // Process each deal
            for (const deal of deals) {
                await this.processDeal(deal);
            }

        } catch (error) {
            logger.log(`Error checking deals: ${error.message}`, 'ERROR');
        } finally {
            this.isChecking = false;

            // Close browsers to prevent zombie processes and lock files
            try {
                logger.log('🧹 Cleaning up browsers...');
                await this.amazonBuyer.closeBrowser();
                await this.bfmrWeb.close();
                logger.log('✅ Browsers closed successfully');
            } catch (cleanupError) {
                logger.log(`⚠️ Error closing browsers: ${cleanupError.message}`, 'WARN');
            }
        }
    }
    async processDeal(deal) {
        // Extract Amazon link
        let amazonLink = null;

        // Simplified Link Finder
        if (deal.items && deal.items[0] && deal.items[0].retailer_links) {
            const link = deal.items[0].retailer_links.find(l => l.retailer && l.retailer.toLowerCase().includes('amazon'));
            if (link) amazonLink = link.url;
        }

        // Fallback structure
        if (!amazonLink && deal.items && deal.items.items && Array.isArray(deal.items.items)) {
            const item = deal.items.items.find(i => i.retailer && i.retailer.toLowerCase().includes('amazon'));
            if (item) amazonLink = item.url;
        }

        if (amazonLink) {
            deal.amazon_link = amazonLink; // Attach for logging
            await this.processAmazonDeal(deal, amazonLink);
        } else {
            logger.log(`Skipping ${deal.title} - No Amazon link found`, 'WARN');
        }
    }

    async processAmazonDeal(deal, amazonLink) {
        logger.log(`📦 Processing: ${deal.title}`);
        logger.log(`   Price: $${deal.retail_price} → Payout: $${deal.payout_price}`);
        logger.log(`   Amazon: ${amazonLink}`);

        try {
            // STEP 1: Validate Amazon product FIRST (before reserving on BFMR)
            logger.log('   🔍 Validating Amazon product...');
            const validation = await this.amazonBuyer.validateProduct(amazonLink, deal.retail_price);

            if (!validation.valid) {
                // Product failed validation - skip BFMR reservation entirely
                if (validation.reason === 'price_mismatch') {
                    logger.log(`   ⚠️ Price mismatch - Amazon: $${validation.amazonPrice}, BFMR: $${validation.bfmrRetailPrice}`, 'WARN');
                    logger.logDeal(deal, 'price_mismatch', `Amazon price ($${validation.amazonPrice}) exceeds BFMR retail ($${validation.bfmrRetailPrice})`, 0);
                } else if (validation.reason === 'out_of_stock') {
                    logger.log('   ⚠️ Out of stock - skipping', 'WARN');
                    logger.logDeal(deal, 'out_of_stock', 'Product unavailable', 0);
                } else if (validation.reason === 'used_or_renewed') {
                    logger.log('   ⚠️ Product is used/renewed/refurbished - skipping', 'WARN');
                    logger.logDeal(deal, 'used_or_renewed', 'Product is not new', 0);
                } else if (validation.reason === 'price_detection_failed') {
                    logger.log('   ⚠️ Could not detect Amazon price - skipping', 'WARN');
                    logger.logDeal(deal, 'price_detection_failed', 'Unable to verify price', 0);
                } else {
                    logger.log(`   ⚠️ Validation failed: ${validation.reason}`, 'WARN');
                    logger.logDeal(deal, 'validation_failed', validation.reason, 0);
                }
                this.dealManager.markAsProcessed(deal.deal_id);
                return; // Skip BFMR reservation
            }

            logger.log('   ✅ Amazon validation passed');

            // STEP 2: Reserve on BFMR (only if Amazon validation passed)
            const bfmrEmail = process.env.BFMR_EMAIL;
            const bfmrPassword = process.env.BFMR_PASSWORD;
            let bfmrData = { limit: null, imageUrl: null };

            if (bfmrEmail && bfmrPassword) {
                logger.log('   🔐 Logging in to BFMR...');
                const loginResult = await this.bfmrWeb.login(bfmrEmail, bfmrPassword);

                if (loginResult.success) {
                    logger.log('   ✅ Successfully logged in to BFMR');
                    this.loginFailures = 0; // Reset counter on success

                    // Scrape deal page for limit and image
                    logger.log('   📄 Scraping BFMR deal page...');
                    bfmrData = await this.bfmrWeb.scrapeDealPage(deal.deal_code);

                    // Attempt reservation using incremental strategy (reserves in batches until limit)
                    if (bfmrData.limit) {
                        logger.log('   📝 Attempting incremental reservation (batches of 2 until limit)...');
                        const reserveResult = await this.bfmrWeb.reserveIncrementally(deal.deal_code, 2);

                        if (reserveResult.success && reserveResult.totalReserved > 0) {
                            logger.log(`   ✅ Reserved ${reserveResult.totalReserved} units on BFMR (${reserveResult.attempts} attempts)`);
                            // Update bfmrData.limit to actual reserved amount for Amazon
                            bfmrData.limit = reserveResult.totalReserved;
                        } else if (reserveResult.totalReserved === 0) {
                            // No units were reserved at all
                            logger.log('   ❌ Could not reserve any units - Skipping Amazon', 'WARN');
                            logger.logDeal(deal, 'reservation_failed', 'BFMR reservation failed: no units reserved', 0);
                            return; // Stop processing
                        } else {
                            logger.log('   ⚠️ Partial failure or unknown reservation state', 'WARN');
                        }
                    } else {
                        logger.log('   ⚠️ No BFMR limit found - Cannot reserve - Skipping', 'WARN');
                        logger.logDeal(deal, 'no_limit', 'Cannot determine BFMR quantity limit', 0);
                        return; // Stop processing
                    }
                } else {
                    // Login Failed - Check severity
                    if (loginResult.fatal) {
                        this.loginFailures++;
                        logger.log(`   ❌ Failed to log in to BFMR (Attempt ${this.loginFailures}/2). Reason: ${loginResult.error}`, 'ERROR');

                        if (this.loginFailures >= 2) {
                            logger.log('   🛑 CRITICAL: Consecutive INVALID CREDENTIALS failures. Pausing bot.', 'ERROR');
                            logger.log('   👉 ACTION REQUIRED: Check email/password in .env', 'ERROR');
                            this.stopPolling();
                            return;
                        }
                        logger.logDeal(deal, 'login_failed', `BFMR Auth Failed: ${loginResult.error}`, 0);
                    } else {
                        // Non-fatal (Network/Crash)
                        logger.log(`   ⚠️ Login Error (Non-Fatal): ${loginResult.error} - Skipping deal but NOT pausing bot`, 'WARN');
                        // Do NOT increment loginFailures
                        logger.logDeal(deal, 'login_error', `BFMR Login Issue: ${loginResult.error}`, 0);
                    }
                    return; // Stop processing this deal
                }
            } else {
                logger.log('   ⚠️ BFMR credentials missing - Cannot reserve - Skipping', 'WARN');
                logger.logDeal(deal, 'no_credentials', 'BFMR reservation required but credentials not provided', 0);
                return; // Stop processing
            }

            // STEP 3: Add to Amazon Cart (validation already passed)
            logger.log('   🛒 Adding to cart...');
            const result = await this.amazonBuyer.buyItem(
                amazonLink,
                deal.deal_code,
                deal.retail_price,
                bfmrData.limit,  // Pass BFMR limit
                bfmrData.imageUrl // Pass image URL
            );

            if (result.success && result.status === 'added_to_cart') {
                logger.log(`   ✅ Successfully added to cart! (Qty: ${result.quantity || 1})`);
                logger.logDeal(deal, 'added_to_cart', `Added at ${result.url}`, result.quantity || 1, result.imageUrl);
                this.dealManager.markAsProcessed(deal.deal_id);
            } else if (result.status === 'price_mismatch') {
                logger.log(`   ⚠️ Price mismatch - Amazon: $${result.amazonPrice}, BFMR: $${result.bfmrRetailPrice}`, 'WARN');
                logger.logDeal(deal, 'price_mismatch', `Amazon price ($${result.amazonPrice}) exceeds BFMR retail ($${result.bfmrRetailPrice})`, 0);
                // Remove from BFMR tracker since we're not buying it
                logger.log('   🗑️ Removing from BFMR tracker...');
                await this.bfmrWeb.unreserveDeal(deal.deal_code);
                this.dealManager.markAsProcessed(deal.deal_id); // Don't retry
            } else if (result.status === 'out_of_stock') {
                logger.log('   ⚠️  Out of stock - skipping', 'WARN');
                logger.logDeal(deal, 'out_of_stock', 'Product unavailable', 0);
                // Remove from BFMR tracker since we're not buying it
                logger.log('   🗑️ Removing from BFMR tracker...');
                await this.bfmrWeb.unreserveDeal(deal.deal_code);
                this.dealManager.markAsProcessed(deal.deal_id); // Mark as processed so we don't retry immediately
            } else if (result.status === 'used_or_renewed') {
                logger.log('   ⚠️  Product is used/renewed/refurbished - skipping', 'WARN');
                logger.logDeal(deal, 'used_or_renewed', 'Product is not new', 0);
                // Remove from BFMR tracker since we're not buying it
                logger.log('   🗑️ Removing from BFMR tracker...');
                await this.bfmrWeb.unreserveDeal(deal.deal_code);
                this.dealManager.markAsProcessed(deal.deal_id); // Don't retry used items
            } else if (result.status === 'verification_failed') {
                logger.log('   ⚠️  Added but could not verify cart - check manually', 'WARN');
                logger.logDeal(deal, 'verification_failed', 'Cart verification failed', 0);
                this.dealManager.markAsFailed(deal.deal_id);
            } else {
                // Log the actual error message if available
                const errorMsg = result.error || result.status || 'Unknown error';
                logger.log(`   ❌ Failed to add to cart: ${errorMsg}`, 'WARN');
                logger.logDeal(deal, 'failed', errorMsg, 0);
                this.dealManager.markAsFailed(deal.deal_id);
            }

        } catch (error) {
            logger.log(`   ❌ Error processing deal: ${error.message}`, 'ERROR');
            logger.logDeal(deal, 'error', error.message, 0);
            this.dealManager.markAsFailed(deal.deal_id);
        }
    }

    async retryDeal(dealCode) {
        if (!this.isRunning) {
            throw new Error('Monitor must be running to retry a deal');
        }

        logger.log(`🔄 Manual Retry triggered for deal: ${dealCode}`);

        // 1. Fetch fresh deal details (try to find in DB or fetch from API)
        let deal = null;

        // Strategy: Fetch all deals and find the one matching code. 
        const response = await this.dealManager.bfmrClient.getDeals();
        if (response && response.deals) {
            deal = response.deals.find(d => d.deal_code === dealCode);
        }

        if (!deal) {
            logger.log(`❌ Could not find deal ${dealCode} in active BFMR list. Cannot retry safely.`, 'ERROR');
            return { success: false, message: 'Deal not found in active list' };
        }

        // 2. Process it
        // Reset processed state so it doesn't verify-skip
        this.dealManager.processedDeals.delete(deal.deal_id);

        // Force process (wait for it)
        await this.processDeal(deal);

        return { success: true, message: `Retry sequence completed for ${dealCode}` };
    }

    async stop() {
        this.stopPolling();
        this.isRunning = false;
        await this.amazonBuyer.closeBrowser();
        await this.bfmrWeb.close();
        logger.log('🛑 Monitor stopped');
    }
}

module.exports = Monitor;
