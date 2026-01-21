require('dotenv').config();
const BfmrClient = require('./src/bfmr-client');

async function inspectDeal() {
    const client = new BfmrClient();
    const response = await client.getDeals();

    // Find a deal with Amazon link
    const deal = response.deals.find(d => {
        const firstItem = d.items && d.items[0];
        return firstItem && firstItem.retailer_links &&
            firstItem.retailer_links.some(link =>
                link.retailer && link.retailer.toLowerCase().includes('amazon')
            );
    });

    if (deal) {
        console.log('Full deal object with all fields:');
        console.log(JSON.stringify(deal, null, 2));
    } else {
        console.log('No deal with Amazon link found');
    }
}

inspectDeal().catch(console.error);
