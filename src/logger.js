const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '..', 'logs');
        this.historyFile = path.join(__dirname, '..', 'data', 'history.json');
        this.ensureDirectories();
    }

    ensureDirectories() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        const dataDir = path.dirname(this.historyFile);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}\n`;

        // Console output
        console.log(logMessage.trim());

        // File output
        const logFile = path.join(this.logDir, 'activity.log');
        fs.appendFileSync(logFile, logMessage);
    }

    logDeal(deal, action, result, quantity = 1, imageUrl = null, retailer = 'amazon', retailerUrl = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            deal_id: deal.deal_id,
            deal_code: deal.deal_code,
            title: deal.title,
            retail_price: deal.retail_price,
            payout_price: deal.payout_price,
            action: action,
            result: result,
            quantity: quantity,
            imageUrl: imageUrl,
            retailer: retailer,
            amazonUrl: retailer === 'amazon' ? (retailerUrl || deal.amazon_link || null) : null,
            bestbuyUrl: retailer === 'bestbuy' ? (retailerUrl || deal.bestbuy_link || null) : null,
            bfmrUrl: `https://bfmr.com/deals/${deal.deal_code}`
        };

        const retailerLabel = retailer === 'bestbuy' ? 'Best Buy' : 'Amazon';
        this.log(`Deal: ${deal.title} (${deal.deal_code}) - ${retailerLabel} - Action: ${action} - Result: ${result} - Qty: ${quantity}`);
        this.addToHistory(entry);
    }

    addToHistory(entry) {
        let history = { deals: [] };

        if (fs.existsSync(this.historyFile)) {
            try {
                const data = fs.readFileSync(this.historyFile, 'utf8');
                history = JSON.parse(data);
            } catch (error) {
                console.warn('Could not read history file, creating new one');
            }
        }

        history.deals.push(entry);

        // Keep only last 1000 entries
        if (history.deals.length > 1000) {
            history.deals = history.deals.slice(-1000);
        }

        fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
    }

    getHistory(limit = 1000) {
        try {
            if (!fs.existsSync(this.historyFile)) {
                return [];
            }

            const data = fs.readFileSync(this.historyFile, 'utf8');
            const history = JSON.parse(data);

            return history.deals.slice(-limit).reverse();
        } catch (error) {
            console.error('Error reading history:', error);
            return [];
        }
    }

    // Get only successful deals (filter out button_not_found, error, etc.)
    getSuccessfulHistory(limit = 1000) {
        const allHistory = this.getHistory(limit);
        const successStatuses = ['browser_opened', 'added_to_cart', 'added_to_cart_dry_run', 'added_to_cart_no_checkout'];

        return allHistory.filter(deal => successStatuses.includes(deal.action));
    }
    // Delete a specific history entry by timestamp (string comparison)
    deleteHistoryEntry(timestamp) {
        if (!fs.existsSync(this.historyFile)) return false;

        try {
            const data = fs.readFileSync(this.historyFile, 'utf8');
            const history = JSON.parse(data);

            const initialLength = history.deals.length;
            history.deals = history.deals.filter(d => d.timestamp !== timestamp);

            if (history.deals.length !== initialLength) {
                fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error deleting history entry:', error);
            return false;
        }
    }
    // Clear history by type
    clearHistory(type) {
        if (!fs.existsSync(this.historyFile)) return false;

        try {
            const data = fs.readFileSync(this.historyFile, 'utf8');
            const history = JSON.parse(data);
            const initialLength = history.deals.length;

            const successStatuses = ['browser_opened', 'added_to_cart', 'added_to_cart_dry_run', 'added_to_cart_no_checkout'];
            const excludedErrors = ['price_mismatch', 'out_of_stock', 'used_or_renewed']; // These are "skips", treated as missed in this context

            if (type === 'missed') {
                // Delete failures: Keep successes
                history.deals = history.deals.filter(d => successStatuses.includes(d.action));
            } else if (type === 'success') {
                // Delete successes: Keep failures
                history.deals = history.deals.filter(d => !successStatuses.includes(d.action));
            } else if (type === 'all') {
                // Delete everything
                history.deals = [];
            } else {
                return false; // Invalid type
            }

            if (history.deals.length !== initialLength) {
                fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
                return true;
            }
            return false; // Nothing changed
        } catch (error) {
            console.error('Error clearing history:', error);
            return false;
        }
    }
}

module.exports = new Logger();
