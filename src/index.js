const BfmrClient = require('./bfmr-client');
const DealManager = require('./deal-manager');
const AmazonBuyer = require('./buyer/amazon');
require('dotenv').config();

async function main() {
    console.log('Starting BFMR Auto-Buyer...');

    const bfmrClient = new BfmrClient();
    const dealManager = new DealManager(bfmrClient);
    const amazonBuyer = new AmazonBuyer();

    try {
        // 1. Fetch Deals
        console.log('Fetching deals from BFMR...');
        const deals = await dealManager.fetchAndFilterDeals();

        if (deals.length === 0) {
            console.log('No actionable deals found.');
            return;
        }

        // 2. Find the first OPEN deal with Amazon link
        let targetDeal = null;
        for (const deal of deals) {
            if (deal.is_reservation_closed) continue;
            const firstItem = deal.items && deal.items[0];
            const hasAmazon = firstItem && (firstItem.retailer_links || []).some(link =>
                link.retailer && link.retailer.toLowerCase().includes('amazon')
            );
            if (hasAmazon) {
                targetDeal = deal;
                break;
            }
        }

        if (!targetDeal) {
            console.log('No open deals with Amazon links found.');
            return;
        }
        // Retailer links are in the items array
        const firstItem = targetDeal.items && targetDeal.items[0];
        const amazonLink = firstItem && (firstItem.retailer_links || []).find(link =>
            link.retailer && link.retailer.toLowerCase().includes('amazon')
        )?.url;
        console.log(`Targeting deal: ${targetDeal.title || 'Unknown Title'}`);
        console.log(`  Amazon Link: ${amazonLink || 'No Amazon link'}`);
        console.log(`  Retail Price: $${targetDeal.retail_price}`);
        console.log(`  Payout: $${targetDeal.payout_price}`);

        if (amazonLink) {
            // 3. Buy
            console.log('Initiating Amazon purchase...');
            await amazonBuyer.buyItem(amazonLink);
        } else {
            console.log('Deal is not from Amazon or missing link. Skipping purchase.');
            console.log('Deal is not from Amazon or missing link. Skipping purchase.');
        }

    } catch (error) {
        console.error('Fatal error in main loop:', error);
    } finally {
        // Cleanup
        // await amazonBuyer.close(); // Keep browser open for debugging in this phase
    }
}

// Run main
if (require.main === module) {
    main();
}
