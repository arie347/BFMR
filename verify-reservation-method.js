/**
 * Verify that a deal was actually reserved by checking the BFMR tracker
 * @param {string} dealCode - The deal code to verify
 * @returns {Promise<{found: boolean, quantity: number}>}
 */
async verifyReservation(dealCode) {
    console.log(`\n🔍 Verifying reservation for ${dealCode} in tracker...`);

    try {
        await this.ensureBrowser();

        // Navigate to tracker
        await this.page.goto('https://www.bfmr.com/tracker', { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for table to load
        await this.page.waitForSelector('table, .tracker-item', { timeout: 10000 });

        // Wait a bit for data to populate
        await new Promise(r => setTimeout(r, 2000));

        // Check if deal code exists in tracker
        const result = await this.page.evaluate((code) => {
            const rows = Array.from(document.querySelectorAll('tr, .tracker-item'));

            for (const row of rows) {
                if (row.textContent.includes(code)) {
                    // Found it! Try to extract quantity
                    const text = row.textContent;
                    // Look for numbers that might be quantity
                    const qtyMatch = text.match(/\b(\d+)\b/);
                    const quantity = qtyMatch ? parseInt(qtyMatch[1]) : 1;

                    return { found: true, quantity };
                }
            }

            return { found: false, quantity: 0 };
        }, dealCode);

        if (result.found) {
            console.log(`✅ Verified: ${dealCode} found in tracker (Qty: ${result.quantity})`);
        } else {
            console.log(`❌ NOT FOUND: ${dealCode} is not in the tracker`);
        }

        return result;

    } catch (error) {
        console.log(`⚠️ Error verifying reservation: ${error.message}`);
        return { found: false, quantity: 0 };
    }
}
