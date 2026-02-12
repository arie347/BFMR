const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const OrderManager = require('./tracker/order-manager');


class DealManager {
    constructor(bfmrClient, bfmrWeb = null) {
        this.bfmrClient = bfmrClient;
        this.bfmrWeb = bfmrWeb;
        console.log(`DealManager initialized. Hybrid Discovery enabled: ${!!this.bfmrWeb}`);
        this.config = {};
        this.processedDeals = new Set();
        this.processingDeals = new Set(); // Track deals currently being processed
        this.loadConfig();
        this.loadHistory();
    }

    loadConfig() {
        try {
            const configPath = path.join(__dirname, '..', 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            this.config = JSON.parse(configData);
        } catch (error) {
            this.config = {
                min_profit_margin_percent: 0,
                min_payout: 0,
                excluded_retailers: [],
                preferred_retailers: [],
                only_open_deals: true
            };
        }
    }

    loadHistory() {
        try {
            const historyPath = path.join(__dirname, '..', 'data', 'history.json');
            if (fs.existsSync(historyPath)) {
                const historyData = fs.readFileSync(historyPath, 'utf8');
                const history = JSON.parse(historyData);
                // Load processed deal IDs from history
                if (history.deals) {
                    history.deals.forEach(deal => {
                        // Only mark as processed if it was successful or out of stock
                        // Failed attempts (errors) can be retried
                        if (['added_to_cart', 'out_of_stock', 'browser_opened'].includes(deal.action)) {
                            this.processedDeals.add(deal.deal_id);
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Error loading history:', error);
        }
    }

    markAsProcessed(dealId) {
        this.processedDeals.add(dealId);
        this.processingDeals.delete(dealId); // Remove from processing set
    }

    // Mark as failed so it can be retried later if needed
    markAsFailed(dealId) {
        this.processingDeals.delete(dealId);
    }

    // Check if deal was already processed (in recent scrapes)
    isAlreadyProcessed(dealId) {
        return this.processedDeals.has(dealId);
    }

    // Check if deal was already ordered
    isAlreadyOrdered(dealCode) {
        return OrderManager.hasDeal(dealCode);
    }

    // Get deal status for dashboard display
    getDealStatus(deal) {
        if (OrderManager.hasDeal(deal.deal_code)) {
            return 'already_ordered';
        }
        if (this.processedDeals.has(deal.deal_id)) {
            return 'already_processed';
        }
        if (this.processingDeals.has(deal.deal_id)) {
            return 'processing';
        }
        return 'new';
    }

    // Clear a deal from processedDeals (allow reprocessing)
    clearProcessed(dealId) {
        this.processedDeals.delete(dealId);
        logger.log(`Cleared deal ${dealId} from processed list - will be reprocessed on next check`);
    }

    async fetchAndFilterDeals() {
        console.log('DEBUG: fetchAndFilterDeals called');
        logger.log('fetchAndFilterDeals called');
        try {
            logger.log('DEBUG: Calling bfmrClient.getDeals()...');
            const response = await this.bfmrClient.getDeals();
            logger.log(`DEBUG: getDeals() returned ${response?.deals?.length || 0} deals`);

            let apiDeals = response && response.deals ? response.deals : [];
            logger.log(`DEBUG: apiDeals initialized with ${apiDeals.length} deals`);
            logger.log(`DEBUG: this.bfmrWeb exists: ${!!this.bfmrWeb}`);


            // Hybrid Discovery: Scrape website for "hidden" deals
            if (this.bfmrWeb) {
                try {
                    logger.log('🔍 Hybrid Discovery: Scraping website for deal slugs...');
                    const scrapedSlugs = await this.bfmrWeb.scrapeDealSlugs();
                    logger.log(`DEBUG: Scraped ${scrapedSlugs.length} slugs from website`);

                    if (scrapedSlugs.length > 0) {
                        // Find slugs that are NOT in the API response
                        const apiSlugs = new Set(apiDeals.map(d => d.slug));
                        const missingSlugs = scrapedSlugs.filter(slug => !apiSlugs.has(slug));

                        if (missingSlugs.length > 0) {
                            logger.log(`Found ${missingSlugs.length} deals missing from API list. Fetching details...`);

                            for (const slug of missingSlugs) {
                                try {
                                    const deal = await this.bfmrClient.getDealBySlug(slug);
                                    if (deal) {
                                        logger.log(`   + Found hidden deal: ${deal.title} (${deal.deal_code})`);

                                        // Check if deal has Amazon link from API
                                        let hasAmazonInApi = false;
                                        
                                        if (deal.items && deal.items[0] && deal.items[0].retailer_links) {
                                            hasAmazonInApi = deal.items[0].retailer_links.some(l =>
                                                l.retailer && l.retailer.toLowerCase().includes('amazon')
                                            );
                                        }
                                        
                                        // Always try to scrape if no Amazon link found in API
                                        if (!hasAmazonInApi && !deal.amazon_link && this.bfmrWeb) {
                                            logger.log(`   ⚠️ No Amazon link in API for hidden deal - Scraping deal page to find it...`);
                                            try {
                                                const scrapedData = await this.bfmrWeb.scrapeDealPage(deal.deal_code);
                                                if (scrapedData.amazonLink) {
                                                    deal.amazon_link = scrapedData.amazonLink;
                                                    logger.log(`   ✅ Found Amazon link via scraping: ${deal.amazon_link}`);
                                                }
                                                // Store Best Buy link if found
                                                if (scrapedData.bestbuyUrl) {
                                                    deal.bestbuy_link = scrapedData.bestbuyUrl;
                                                    logger.log(`   ✅ Found Best Buy link via scraping: ${deal.bestbuy_link}`);
                                                }
                                                // Also reuse limit/image if scraped
                                                if (scrapedData.limit) deal.limit_per_household = scrapedData.limit;
                                                if (scrapedData.imageUrl) deal.image_url = scrapedData.imageUrl;

                                            } catch (scrapeErr) {
                                                logger.log(`   ❌ Failed to scrape hidden deal page: ${scrapeErr.message}`, 'WARN');
                                            }
                                        }

                                        // Now, check if the deal is valid after potential scraping
                                        if (this.isDealActionable(deal)) {
                                            apiDeals.push(deal);
                                            logger.log(`   ✅ Added hidden deal to the list!`);
                                        } else {
                                            logger.log(`   ⚠️ Hidden deal invalid or missing details (e.g. Amazon link) - skipping`);
                                        }
                                    }
                                } catch (error) {
                                    logger.log(`   ❌ Error fetching details for hidden deal ${slug}: ${error.message}`, 'WARN');
                                }
                            }
                        }
                    } else {
                        logger.log('✅ All scraped deals are present in API list');
                    }
                } catch (error) {
                    logger.log(`⚠️ Hybrid Discovery failed (continuing with API deals only): ${error.message}`, 'WARN');
                } finally {
                    // Always close the scraper browser to prevent lock file issues
                    if (this.bfmrWeb) {
                        try {
                            await this.bfmrWeb.close();
                            logger.log('DEBUG: Closed BFMR scraper browser');
                        } catch (e) {
                            console.log('Error closing BFMR browser:', e.message);
                        }
                    }
                }
            }

            if (apiDeals.length === 0) {
                return [];
            }

            const actionableDeals = [];

            for (const deal of apiDeals) {
                // Skip if currently being processed (prevents concurrent processing of same deal)
                if (this.processingDeals.has(deal.deal_id)) {
                    continue;
                }
                
                // Skip if already processed (in recent scrapes with successful action)
                if (this.processedDeals.has(deal.deal_id)) {
                    continue;
                }

                if (this.isDealActionable(deal)) {
                    actionableDeals.push(deal);
                    this.processingDeals.add(deal.deal_id); // Mark as processing immediately
                }
            }

            return actionableDeals;

        } catch (error) {
            console.error('Error fetching deals:', error);
            return [];
        }
    }

    isDealActionable(deal) {
        // Handle both nested filters object (from config.json) and flat config (fallback)
        const filters = this.config.filters || this.config;

        // Skip if deal has already been ordered (Order Manager)
        if (OrderManager.hasDeal(deal.deal_code)) {
            return false;
        }

        // 1. Check Profit Margin (Percentage)
        // Profit = Payout - Retail Price
        // Margin % = (Profit / Retail Price) * 100
        const profit = deal.payout_price - deal.retail_price;
        const marginPercent = (profit / deal.retail_price) * 100;

        if (marginPercent < filters.min_profit_margin_percent) {
            return false;
        }

        // 2. Check Minimum Payout
        if (deal.payout_price < filters.min_payout) {
            return false;
        }

        // 3. Check Retailer Availability and Enablement
        let hasActionableRetailer = false;

        // Initialize enabled retailers from config (default Amazon true if missing)
        const amazonEnabled = this.config.retailer_settings?.amazon?.enabled !== false;
        const bestbuyEnabled = this.config.retailer_settings?.bestbuy?.enabled === true;

        // Check Structure 1 (deal.items[0].retailer_links[])
        if (deal.items && deal.items[0] && deal.items[0].retailer_links) {
            hasActionableRetailer = deal.items[0].retailer_links.some(l => {
                const r = l.retailer ? l.retailer.toLowerCase() : '';
                if (r.includes('amazon') && amazonEnabled) return true;
                if (r.includes('best buy') && bestbuyEnabled) return true;
                return false;
            });
        }

        // Check Structure 2 (deal.items.items[]) if not found yet
        if (!hasActionableRetailer && deal.items && deal.items.items && Array.isArray(deal.items.items)) {
            hasActionableRetailer = deal.items.items.some(item => {
                const r = item.retailer ? item.retailer.toLowerCase() : '';
                if (r.includes('amazon') && amazonEnabled) return true;
                if (r.includes('best buy') && bestbuyEnabled) return true;
                return false;
            });
        }
        
        // Check scraped/direct links (for hidden deals)
        if (!hasActionableRetailer) {
            if (amazonEnabled && deal.amazon_link) {
                hasActionableRetailer = true;
            }
            if (bestbuyEnabled && deal.bestbuy_link) {
                hasActionableRetailer = true;
            }
        }

        if (!hasActionableRetailer) {
            return false;
        }

        // 4. Check Excluded Retailers (Legacy)
        if (filters.excluded_retailers && filters.excluded_retailers.length > 0) {
            // Already handled by explicit enablement above, but keep as safety if needed
        }

        // 5. Check Open Status
        if (filters.only_open_deals && deal.is_reservation_closed) {
            return false;
        }

        return true;
    }
}

module.exports = DealManager;
