const BfmrClient = require('./src/bfmr-client');
const DealManager = require('./src/deal-manager');
const logger = require('./src/logger');

async function diagnose() {
    const client = new BfmrClient();
    const manager = new DealManager(client); // No web needed for this check

    const slug = 'apple-watch-se-3-44mm-m-l-sport-band-midnight';
    console.log(`Fetching deal: ${slug}...`);

    const deal = await client.getDealBySlug(slug);

    if (!deal) {
        console.log('❌ Deal NOT FOUND by API (getDealBySlug returned null)');
        return;
    }

    console.log('✅ Deal FOUND!');
    console.log('--- Deal Details ---');
    console.log(`Title: ${deal.title}`);
    console.log(`Status: ${deal.status}`);
    console.log(`Is Closed: ${deal.is_reservation_closed}`);
    console.log(`Retail Price: $${deal.retail_price}`);
    console.log(`Payout Price: $${deal.payout_price}`);

    const profit = deal.payout_price - deal.retail_price;
    const margin = (profit / deal.retail_price) * 100;
    console.log(`Profit: $${profit.toFixed(2)} (${margin.toFixed(2)}%)`);

    if (deal.items && deal.items[0]) {
        console.log('Retailers:');
        deal.items[0].retailer_links.forEach(l => {
            console.log(`- ${l.retailer}: ${l.url}`);
        });
    } else {
        console.log('No items/retailers found in deal object');
    }

    console.log('--- Filter Check ---');
    const isActionable = manager.isDealActionable(deal);
    console.log(`isDealActionable: ${isActionable}`);

    if (!isActionable) {
        console.log('Reasons for rejection:');
        const filters = manager.config.filters;

        if (margin < filters.min_profit_margin_percent) console.log(`- Low margin: ${margin.toFixed(2)}% < ${filters.min_profit_margin_percent}%`);
        if (deal.payout_price < filters.min_payout) console.log(`- Low payout: ${deal.payout_price} < ${filters.min_payout}`);
        if (filters.only_open_deals && deal.is_reservation_closed) console.log(`- Deal is CLOSED`);

        const hasAmazon = deal.items && deal.items[0] && deal.items[0].retailer_links &&
            deal.items[0].retailer_links.some(l => l.retailer && l.retailer.toLowerCase().includes('amazon'));
        if (!hasAmazon) console.log(`- No Amazon link found`);
    }
}

diagnose();
