require('dotenv').config();
const BfmrClient = require('./src/bfmr-client');

async function checkIfInAPI() {
    const client = new BfmrClient();
    const response = await client.getDeals();
    const deals = response.deals || [];

    console.log(`Total deals from API: ${deals.length}`);

    const appleWatchSE3 = deals.find(d =>
        d.slug === 'apple-watch-se-3-44mm-m-l-sport-band-midnight' ||
        d.title.toLowerCase().includes('apple watch se 3')
    );

    if (appleWatchSE3) {
        console.log('✅ Apple Watch SE 3 IS in the API response!');
        console.log('Deal:', appleWatchSE3.title);
        console.log('Slug:', appleWatchSE3.slug);
    } else {
        console.log('❌ Apple Watch SE 3 is NOT in the API response');
        console.log('This confirms it\'s a "hidden" deal that needs hybrid discovery');
    }
}

checkIfInAPI();
