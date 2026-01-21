require('dotenv').config();
const AmazonBuyer = require('./src/buyer/amazon');

async function checkLogin() {
    console.log('🔍 Checking Amazon login status...');
    const buyer = new AmazonBuyer();

    try {
        const isLoggedIn = await buyer.checkLoginStatus();
        if (isLoggedIn) {
            console.log('✅ Logged in!');
        } else {
            console.log('❌ Not logged in. Please run the login script manually or enable auto-login.');
            // Attempt login
            console.log('🔄 Attempting login...');
            await buyer.login(process.env.AMAZON_EMAIL, process.env.AMAZON_PASSWORD);
        }
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await buyer.closeBrowser();
    }
}

checkLogin();
