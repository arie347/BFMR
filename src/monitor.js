const BfmrClient = require('./bfmr-client');
const DealManager = require('./deal-manager');
const AmazonBuyer = require('./buyer/amazon');
const BestBuyBuyer = require('./buyer/bestbuy');
const BfmrWeb = require('./buyer/bfmr-web');
const AmazonOrderTracker = require('./tracker/amazon-order-tracker');
const logger = require('./logger');
const emailService = require('./email-service');
const fs = require('fs');
const path = require('path');

class Monitor {
    constructor() {
        this.bfmrClient = new BfmrClient();
        this.amazonBuyer = new AmazonBuyer();
        this.bestbuyBuyer = new BestBuyBuyer();
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
        
        // Collect results for summary email
        this.runResults = [];

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

            // Send summary email if we have results
            if (this.runResults && this.runResults.length > 0) {
                await emailService.sendSummaryEmail(this.runResults);
            }

            // Close browsers to prevent zombie processes and lock files
            try {
                logger.log('🧹 Cleaning up browsers...');
                await this.amazonBuyer.closeBrowser();
                await this.bestbuyBuyer.closeBrowser();
                await this.bfmrWeb.close();
                logger.log('✅ Browsers closed successfully');
            } catch (cleanupError) {
                logger.log(`⚠️ Error closing browsers: ${cleanupError.message}`, 'WARN');
            }
        }
    }
    async processDeal(deal) {
        // Reload config to pick up any changes
        this.config = this.loadConfig();
        
        const amazonEnabled = this.config.retailer_settings?.amazon?.enabled !== false;
        const amazonMaxQty = this.config.retailer_settings?.amazon?.max_per_order || 3;
        const bestbuyEnabled = this.config.retailer_settings?.bestbuy?.enabled === true;
        const bestbuyMaxQty = this.config.retailer_settings?.bestbuy?.max_per_order || 2;
        
        // Extract retailer links
        let amazonLink = null;
        let bestbuyLink = null;

        // Simplified Link Finder
        if (deal.items && deal.items[0] && deal.items[0].retailer_links) {
            const amazonLinkObj = deal.items[0].retailer_links.find(l => l.retailer && l.retailer.toLowerCase().includes('amazon'));
            if (amazonLinkObj) amazonLink = amazonLinkObj.url;
            
            const bestbuyLinkObj = deal.items[0].retailer_links.find(l => l.retailer && l.retailer.toLowerCase().includes('best buy'));
            if (bestbuyLinkObj) bestbuyLink = bestbuyLinkObj.url;
        }

        // Fallback structure
        if (deal.items && deal.items.items && Array.isArray(deal.items.items)) {
            if (!amazonLink) {
                const item = deal.items.items.find(i => i.retailer && i.retailer.toLowerCase().includes('amazon'));
                if (item) amazonLink = item.url;
            }
            if (!bestbuyLink) {
                const item = deal.items.items.find(i => i.retailer && i.retailer.toLowerCase().includes('best buy'));
                if (item) bestbuyLink = item.url;
            }
        }

        logger.log(`📦 Processing: ${deal.title}`);
        logger.log(`   Price: $${deal.retail_price} → Payout: $${deal.payout_price}`);

        // ========== PHASE 1: VALIDATE ALL RETAILERS FIRST ==========
        // This prevents cluttering BFMR tracker with deals we can't buy
        
        const validRetailers = [];
        let totalBuyable = 0;

        // Validate Amazon
        if (amazonEnabled && amazonLink) {
            logger.log('   🔍 Validating Amazon...');
            const validation = await this.amazonBuyer.validateProduct(amazonLink, deal.retail_price);
            
            if (validation.valid) {
                logger.log(`   ✅ Amazon: Valid (price $${validation.amazonPrice || deal.retail_price})`);
                validRetailers.push({
                    name: 'amazon',
                    link: amazonLink,
                    maxQty: amazonMaxQty,
                    validation
                });
                totalBuyable += amazonMaxQty;
            } else {
                logger.log(`   ❌ Amazon: ${validation.reason}`);
            }
        }

        // Validate Best Buy (need to get BB URL from BFMR first)
        if (bestbuyEnabled) {
            logger.log('   🔍 Checking Best Buy availability...');
            
            // Scrape BFMR for Best Buy SKU/URL
            const bfmrEmail = process.env.BFMR_EMAIL;
            const bfmrPassword = process.env.BFMR_PASSWORD;
            
            if (bfmrEmail && bfmrPassword) {
                await this.bfmrWeb.login(bfmrEmail, bfmrPassword);
                const bfmrData = await this.bfmrWeb.scrapeDealPage(deal.deal_code);
                
                if (bfmrData.bestbuyUrl) {
                    deal.bestbuy_link = bfmrData.bestbuyUrl;
                    deal.imageUrl = bfmrData.imageUrl;
                    
                    const validation = await this.bestbuyBuyer.validateProduct(bfmrData.bestbuyUrl, deal.retail_price);
                    
                    if (validation.valid) {
                        logger.log(`   ✅ Best Buy: Valid (price $${validation.bestbuyPrice})`);
                        validRetailers.push({
                            name: 'bestbuy',
                            link: bfmrData.bestbuyUrl,
                            maxQty: bestbuyMaxQty,
                            validation,
                            imageUrl: bfmrData.imageUrl
                        });
                        totalBuyable += bestbuyMaxQty;
                    } else {
                        logger.log(`   ❌ Best Buy: ${validation.reason}`);
                    }
                } else {
                    logger.log('   ❌ Best Buy: No link found on BFMR');
                }
            }
        }

        // ========== PHASE 2: CHECK IF ANY RETAILER IS VALID ==========
        
        if (validRetailers.length === 0) {
            logger.log('   ⚠️ No valid retailers found - skipping BFMR reservation');
            this.dealManager.markAsFailed(deal.deal_id);
            return;
        }

        logger.log(`   📊 Valid retailers: ${validRetailers.map(r => r.name).join(', ')} (can buy up to ${totalBuyable} total)`);

        // ========== PHASE 3: RESERVE ON BFMR ==========
        // Only reserve what we can actually buy
        
        const bfmrEmail = process.env.BFMR_EMAIL;
        const bfmrPassword = process.env.BFMR_PASSWORD;
        
        if (!bfmrEmail || !bfmrPassword) {
            logger.log('   ⚠️ BFMR credentials missing - cannot reserve');
            this.dealManager.markAsFailed(deal.deal_id);
            return;
        }

        await this.bfmrWeb.login(bfmrEmail, bfmrPassword);
        
        logger.log(`   📝 Reserving up to ${totalBuyable} units on BFMR...`);
        const reserveResult = await this.bfmrWeb.reserveIncrementally(deal.deal_code, 2, totalBuyable);
        
        if (!reserveResult.success || reserveResult.totalReserved === 0) {
            logger.log('   ⚠️ Could not reserve any units on BFMR - limit may be reached');
            this.dealManager.markAsFailed(deal.deal_id);
            return;
        }

        logger.log(`   ✅ Reserved ${reserveResult.totalReserved} units on BFMR`);

        // ========== PHASE 4: SPLIT AND BUY FROM EACH RETAILER ==========
        
        let remaining = reserveResult.totalReserved;
        
        for (const retailer of validRetailers) {
            if (remaining <= 0) break;
            
            const qtyToBuy = Math.min(remaining, retailer.maxQty);
            
            if (retailer.name === 'amazon') {
                await this.buyFromAmazon(deal, retailer.link, qtyToBuy, deal.imageUrl || retailer.imageUrl);
            } else if (retailer.name === 'bestbuy') {
                await this.logBestBuyForManualAdd(deal, retailer.link, qtyToBuy, retailer.imageUrl);
            }
            
            remaining -= qtyToBuy;
        }

        if (remaining > 0) {
            logger.log(`   ⚠️ ${remaining} units reserved but couldn't be allocated to retailers`);
        }

        this.dealManager.markAsFailed(deal.deal_id); // Clear from processing set
    }
    
    // Helper: Buy from Amazon (add to cart)
    async buyFromAmazon(deal, amazonLink, quantity, imageUrl) {
        logger.log(`   🛒 Adding ${quantity} to Amazon cart...`);
        
        try {
            const result = await this.amazonBuyer.buyItem(
                amazonLink,
                deal.deal_code,
                deal.retail_price,
                quantity,
                imageUrl
            );

            if (result.success && result.status === 'added_to_cart') {
                logger.log(`   ✅ Amazon: Added ${result.quantity || quantity} to cart`);
                logger.logDeal(deal, 'added_to_cart', `Added at ${result.url}`, result.quantity || quantity, imageUrl, 'amazon', result.url);
                
                // Collect result for summary email
                this.runResults.push({
                    deal,
                    action: 'added_to_cart',
                    retailer: 'amazon',
                    quantity: result.quantity || quantity,
                    url: result.url,
                    success: true
                });
            } else {
                logger.log(`   ❌ Amazon: Failed - ${result.status || result.error}`);
                logger.logDeal(deal, result.status || 'failed', result.error || 'Unknown error', 0, imageUrl, 'amazon');
            }
        } catch (error) {
            logger.log(`   ❌ Amazon error: ${error.message}`, 'ERROR');
        }
    }
    
    // Helper: Log Best Buy for manual add (don't add to cart automatically)
    async logBestBuyForManualAdd(deal, bestbuyUrl, quantity, imageUrl) {
        logger.log(`   📋 Best Buy: Logging ${quantity} for manual add`);
        
        logger.logDeal(
            deal, 
            'pending_manual_add', 
            `Reserved ${quantity} on BFMR - Add manually`, 
            quantity, 
            imageUrl,
            'bestbuy',
            bestbuyUrl
        );
        
        // Collect result for summary email
        this.runResults.push({
            deal,
            action: 'pending_manual_add',
            retailer: 'bestbuy',
            quantity,
            url: bestbuyUrl,
            success: true
        });
        
        logger.log(`   ✅ Best Buy: Ready for manual add`);
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
        await this.bestbuyBuyer.closeBrowser();
        await this.bfmrWeb.close();
        logger.log('🛑 Monitor stopped');
    }
}

module.exports = Monitor;
