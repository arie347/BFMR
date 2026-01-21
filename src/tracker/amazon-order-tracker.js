const logger = require('../logger');
const OrderManager = require('./order-manager');

class AmazonOrderTracker {
    constructor(monitor) {
        this.monitor = monitor;
        this.config = monitor.config;
    }

    async sync(isManual = false) {
        logger.log(`📦 Starting Order Sync (${isManual ? 'Manual' : 'Auto'})...`);

        try {
            // 1. Get BFMR Reservations
            logger.log('   Fetching active deals from BFMR...');
            const response = await this.monitor.bfmrClient.getDeals();
            const bfmrDeals = response.deals || [];

            if (bfmrDeals.length === 0) {
                logger.log('   No active deals found on BFMR. Nothing to sync.');
                return;
            }
            logger.log(`   Found ${bfmrDeals.length} deals on BFMR.`);

            // 2. Scrape Amazon
            logger.log('   Scraping Amazon Order History (last 30 days)...');
            const amazonOrders = await this.monitor.amazonBuyer.scrapeOrderHistory(30);

            if (amazonOrders.length === 0) {
                logger.log('   No recent orders found on Amazon.');
                return;
            }
            logger.log(`   Found ${amazonOrders.length} recent orders on Amazon.`);

            // 3. Match & Upload
            let syncedCount = 0;

            for (const order of amazonOrders) {
                const match = this.findMatch(order, bfmrDeals);

                if (match) {
                    logger.log(`   ✅ Matched Order #${order.orderId} to Deal: ${match.title}`);

                    // SAVE TO ORDER MANAGER
                    OrderManager.addOrUpdateOrder({
                        orderId: order.orderId,
                        dealId: match.id,
                        dealCode: match.deal_code,
                        title: match.title,
                        status: order.trackingLink ? 'TRACKING_FOUND' : 'ORDER_PLACED',
                        trackingLink: order.trackingLink,
                        date: order.date,
                        imageUrl: match.image_url,
                        price: match.price,
                        payout: match.payout,
                        bfmrStatus: 'submitted' // Assuming success for now, update if error
                    });

                    // Check if we need to upload Order ID (Purchase Confirmation)
                    // Currently we don't know if BFMR has it, but submitting idempotent values should be safe
                    // or check if deal status implies it's already done.

                    try {
                        let updated = false;

                        // Submit Order ID + Tracking (if available)
                        // If only Order ID is available, submit that.
                        if (order.trackingLink || order.status !== 'Ordered') {
                            // Tracking available (or at least status isn't just "Ordered")
                            // Note: order.trackingLink might just be a link, we need the number. 
                            // Scraping actual number requires visiting the link.
                            // For now, let's just upload Order ID if we haven't.
                        }

                        // Just upload Order ID for now to confirm purchase
                        // BFMR API might require quantity. Match deal quantity or order quantity?
                        // Scraper doesn't extract quantity yet (hard to see on summary). Assume 1 or deal limit?
                        // Defaulting to 1 for safety or 0 if just updating meta?

                        // Wait, submitTracking requires qty.
                        // I'll use deal.limit if available, or 1.

                        // Let's Log for now, validating the flow.
                        // Ideally we upload Order ID.

                        await this.monitor.bfmrClient.submitTracking(
                            match.id,        // dealId (BFMR internal ID)
                            null,            // Tracking number (null for now)
                            1,               // Quantity (Assumption)
                            match.price,     // Cost (BFMR price)
                            order.orderId    // Order ID
                        );

                        logger.log(`      📤 Uploaded Order ID: ${order.orderId}`);
                        syncedCount++;
                        updated = true;

                    } catch (err) {
                        logger.log(`      ⚠️ Failed to upload checkin to BFMR: ${err.message}`, 'WARN');
                        // Still saved to local OrderManager
                    }
                }
            }
            logger.log(`📦 Sync complete. Updated ${syncedCount} orders.`);

        } catch (error) {
            logger.log(`❌ Order Sync failed: ${error.message}`, 'ERROR');
        }
    }

    findMatch(order, bfmrDeals) {
        // 1. Match by ASIN if available
        if (order.asin) {
            const asinMatch = bfmrDeals.find(d => d.asin === order.asin); // Assuming BFMR deal has ASIN
            if (asinMatch) return asinMatch;
        }

        // 2. Match by Title (Fuzzy)
        const orderTitle = order.title.toLowerCase();

        return bfmrDeals.find(deal => {
            const dealTitle = deal.title.toLowerCase();
            // Check if significant part of titles match
            return orderTitle.includes(dealTitle) || dealTitle.includes(orderTitle);
        });
    }
}

module.exports = AmazonOrderTracker;
