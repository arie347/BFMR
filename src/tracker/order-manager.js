const fs = require('fs');
const path = require('path');
const logger = require('../logger');

class OrderManager {
    constructor() {
        this.ordersFile = path.join(__dirname, '..', '..', 'data', 'orders.json');
        this.orders = { orders: [] };
        this.loadOrders();
    }

    loadOrders() {
        try {
            if (fs.existsSync(this.ordersFile)) {
                const data = fs.readFileSync(this.ordersFile, 'utf8');
                this.orders = JSON.parse(data);
                if (!this.orders.orders) this.orders.orders = [];
            } else {
                this.saveOrders(); // Create file if it doesn't exist
            }
        } catch (error) {
            logger.log(`Error loading orders: ${error.message}`, 'ERROR');
            // Backup corrupt file?
        }
    }

    saveOrders() {
        try {
            const dir = path.dirname(this.ordersFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.ordersFile, JSON.stringify(this.orders, null, 2));
        } catch (error) {
            logger.log(`Error saving orders: ${error.message}`, 'ERROR');
        }
    }

    getOrders() {
        return this.orders.orders;
    }

    // Add or update an order
    addOrUpdateOrder(orderData) {
        if (!orderData.orderId) {
            logger.log('Refusing to add order without Order ID', 'WARN');
            return;
        }

        const cleanOrderId = String(orderData.orderId).trim();
        const index = this.orders.orders.findIndex(o => String(o.orderId).trim() === cleanOrderId);

        if (index >= 0) {
            // Update existing
            this.orders.orders[index] = { ...this.orders.orders[index], ...orderData, orderId: cleanOrderId };
            logger.log(`Updated order: ${cleanOrderId}`);
        } else {
            // Add new
            this.orders.orders.push({
                status: 'ORDER_PLACED',
                timestamp: new Date().toISOString(),
                ...orderData,
                orderId: cleanOrderId
            });
            logger.log(`Added new order: ${cleanOrderId}`);
        }
        this.saveOrders();
    }

    // Check if a deal has been ordered
    hasDeal(dealCode) {
        return this.orders.orders.some(o => String(o.dealCode) === String(dealCode));
    }
}

module.exports = new OrderManager();
