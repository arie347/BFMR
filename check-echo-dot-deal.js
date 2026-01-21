require('dotenv').config();
const BfmrWeb = require('./src/buyer/bfmr-web');

async function checkDeal() {
    console.log('🔍 Checking Amazon Echo Dot 5 deal on BFMR...\n');

    const bfmrWeb = new BfmrWeb();

    try {
        // Login
        console.log('🔐 Logging in...');
        const loggedIn = await bfmrWeb.login(process.env.BFMR_EMAIL, process.env.BFMR_PASSWORD);

        if (!loggedIn) {
            console.log('❌ Login failed');
            return;
        }

        // Navigate to the deal page
        const dealCode = 'D-XDOSW';
        console.log(`\n📄 Navigating to deal ${dealCode}...`);
        await bfmrWeb.page.goto(`https://www.bfmr.com/deals/${dealCode}`, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait a bit for page to load
        await new Promise(r => setTimeout(r, 3000));

        // Check page content
        const pageInfo = await bfmrWeb.page.evaluate(() => {
            const bodyText = document.body.innerText;

            return {
                hasClosed: bodyText.includes('Reservation Closed') || bodyText.includes('Deal Expired'),
                hasReserveButton: !!document.querySelector('button.bfmr-btn-green'),
                buttonDisabled: document.querySelector('button.bfmr-btn-green')?.disabled || false,
                buttonText: document.querySelector('button.bfmr-btn-green')?.textContent?.trim() || 'Not found',
                pageText: bodyText.substring(0, 500)
            };
        });

        console.log('\n📊 Deal Status:');
        console.log(`   Closed message: ${pageInfo.hasClosed ? '❌ YES' : '✅ NO'}`);
        console.log(`   Reserve button found: ${pageInfo.hasReserveButton ? '✅ YES' : '❌ NO'}`);
        console.log(`   Button disabled: ${pageInfo.buttonDisabled ? '❌ YES' : '✅ NO'}`);
        console.log(`   Button text: "${pageInfo.buttonText}"`);
        console.log(`\n📄 Page preview:\n${pageInfo.pageText}\n`);

        if (pageInfo.hasClosed) {
            console.log('❌ Deal is CLOSED');
        } else if (!pageInfo.hasReserveButton) {
            console.log('⚠️ Reserve button not found - might be a page loading issue');
        } else if (pageInfo.buttonDisabled) {
            console.log('⚠️ Reserve button is DISABLED - likely hit limit');
        } else {
            console.log('✅ Deal appears to be ACTIVE and reservable!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await bfmrWeb.close();
    }
}

checkDeal();
