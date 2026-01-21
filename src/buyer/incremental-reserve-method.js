    /**
     * Reserve deal incrementally in batches of 2 until limit is reached
     * @param {string} dealCode - The deal code to reserve
     * @param {number} batchSize - Size of each reservation batch (default: 2)
     * @returns {Promise<{success: boolean, totalReserved: number, attempts: number}>}
     */
    async reserveIncrementally(dealCode, batchSize = 2) {
    console.log(`\n🔄 Starting incremental reservation for ${dealCode} (batch size: ${batchSize})`);

    let totalReserved = 0;
    let attempts = 0;
    let continueReserving = true;

    while (continueReserving) {
        attempts++;
        console.log(`\n📝 Attempt #${attempts}: Reserving ${batchSize} units...`);

        const result = await this.reserveDeal(dealCode, batchSize);

        if (result.success) {
            totalReserved += batchSize;
            console.log(`✅ Successfully reserved ${batchSize} units (Total: ${totalReserved})`);

            // Wait a bit between reservations to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log(`⚠️ Reservation failed: ${result.status}`);

            // Check if we hit the limit
            if (result.status === 'closed' || result.status === 'error') {
                console.log(`❌ Deal is closed or error occurred. Stopping.`);
                continueReserving = false;
            } else if (result.status === 'unknown') {
                // Unknown status might mean we hit the limit (BFMR silently rejects)
                console.log(`⚠️ Unknown status - likely hit reservation limit`);
                continueReserving = false;
            } else {
                continueReserving = false;
            }
        }

        // Safety limit: don't try more than 25 times (50 units max if batch=2)
        if (attempts >= 25) {
            console.log(`⚠️ Reached maximum attempts (${attempts}). Stopping for safety.`);
            continueReserving = false;
        }
    }

    console.log(`\n📊 Incremental Reservation Complete:`);
    console.log(`   Total Reserved: ${totalReserved} units`);
    console.log(`   Attempts: ${attempts}`);

    return {
        success: totalReserved > 0,
        totalReserved,
        attempts
    };
}
