const BfmrClient = require('./src/bfmr-client');

async function listDeals() {
    const client = new BfmrClient();
    try {
        console.log('Fetching deals from BFMR...\n');
        const dealsData = await client.getDeals();
        const deals = dealsData.deals || [];

        console.log(`Found ${deals.length} deals. Here are the first 10:\n`);

        deals.slice(0, 10).forEach((deal, index) => {
            const firstItem = deal.items && deal.items[0];
            const amazonLink = firstItem && (firstItem.retailer_links || []).find(link =>
                link.retailer && link.retailer.toLowerCase().includes('amazon')
            );

            console.log(`${index + 1}. ${deal.title}`);
            console.log(`   Deal Code: ${deal.deal_code}`);
            console.log(`   Retail: $${deal.retail_price} → Payout: $${deal.payout_price}`);
            console.log(`   Retailers: ${deal.retailers}`);
            console.log(`   Has Amazon: ${amazonLink ? 'YES' : 'NO'}`);
            console.log(`   Reservation Closed: ${deal.is_reservation_closed ? 'YES' : 'NO'}`);
            console.log('');
        });
    } catch (error) {
        console.error('Failed:', error.message);
    }
}

listDeals();
