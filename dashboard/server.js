const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const logger = require('../src/logger');

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Monitor state
let monitorState = {
    autoMode: false,
    isPolling: false,
    lastCheck: null
};

let pollingInterval = null;

// API: Get config
app.get('/api/config', (req, res) => {
    try {
        const configPath = path.join(__dirname, '..', 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Update config
app.post('/api/config', (req, res) => {
    try {
        const configPath = path.join(__dirname, '..', 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
        logger.log('Config updated via dashboard');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Get history
app.get('/api/history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = logger.getHistory(limit);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Delete history entry by timestamp
app.delete('/api/history/:timestamp', (req, res) => {
    try {
        const timestamp = req.params.timestamp;
        const historyPath = path.join(__dirname, '..', 'data', 'history.json');
        
        if (!fs.existsSync(historyPath)) {
            return res.status(404).json({ success: false, error: 'History file not found' });
        }
        
        const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        const originalLength = data.deals ? data.deals.length : 0;
        
        if (data.deals) {
            data.deals = data.deals.filter(d => d.timestamp !== timestamp);
        }
        
        fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
        
        const deleted = originalLength - (data.deals ? data.deals.length : 0);
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Clear history by type (missed or success)
app.delete('/api/history', (req, res) => {
    try {
        const type = req.query.type;
        const historyPath = path.join(__dirname, '..', 'data', 'history.json');
        
        if (!fs.existsSync(historyPath)) {
            return res.json({ success: true, deleted: 0 });
        }
        
        const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        const originalLength = data.deals ? data.deals.length : 0;
        
        const successStatuses = ['browser_opened', 'added_to_cart', 'added_to_cart_dry_run', 'added_to_cart_no_checkout', 'pending_manual_add'];
        
        if (type === 'missed') {
            // Remove all non-success entries
            data.deals = data.deals.filter(d => successStatuses.includes(d.action));
        } else if (type === 'success') {
            // Remove all success entries
            data.deals = data.deals.filter(d => !successStatuses.includes(d.action));
        }
        
        fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
        
        const deleted = originalLength - data.deals.length;
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Get logs
app.get('/api/logs', (req, res) => {
    try {
        const logFile = path.join(__dirname, '..', 'logs', 'activity.log');
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8').split('\n').slice(-100).reverse();
            res.json(logs.filter(l => l.trim()));
        } else {
            res.json([]);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Get monitor status
app.get('/api/monitor/status', (req, res) => {
    res.json({
        autoMode: monitorState.autoMode,
        isPolling: monitorState.isPolling,
        lastCheck: monitorState.lastCheck
    });
});

// API: Set monitor mode (auto/manual)
app.post('/api/monitor/mode', (req, res) => {
    const { auto } = req.body;
    monitorState.autoMode = auto;
    
    if (auto && !pollingInterval) {
        // Start auto polling
        startAutoPolling();
    } else if (!auto && pollingInterval) {
        // Stop auto polling
        clearInterval(pollingInterval);
        pollingInterval = null;
        monitorState.isPolling = false;
    }
    
    res.json({ success: true, autoMode: monitorState.autoMode });
});

// API: Manual check (Check Now button)
app.post('/api/monitor/check', async (req, res) => {
    try {
        monitorState.isPolling = true;
        monitorState.lastCheck = new Date().toISOString();
        
        // Run the monitor
        const Monitor = require('../src/monitor');
        const monitor = new Monitor();
        
        logger.log('Manual check triggered from dashboard');
        await monitor.checkDeals();
        
        monitorState.isPolling = false;
        res.json({ success: true, message: 'Check completed' });
    } catch (error) {
        monitorState.isPolling = false;
        logger.error('Manual check failed: ' + error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: Retry a specific deal
app.post('/api/monitor/retry', async (req, res) => {
    try {
        const { deal_code } = req.body;
        
        if (!deal_code) {
            return res.status(400).json({ success: false, message: 'deal_code is required' });
        }
        
        logger.log(`Retry requested for deal: ${deal_code}`);
        
        // Run monitor with specific deal code
        const Monitor = require('../src/monitor');
        const monitor = new Monitor();
        
        await monitor.retryDeal(deal_code);
        
        res.json({ success: true, message: 'Retry started' });
    } catch (error) {
        logger.error('Retry failed: ' + error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: Get orders
app.get('/api/orders', (req, res) => {
    try {
        const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
        if (fs.existsSync(ordersPath)) {
            const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
            res.json(orders);
        } else {
            res.json([]);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Sync orders
app.post('/api/monitor/sync', async (req, res) => {
    try {
        logger.log('Order sync triggered from dashboard');
        // Placeholder - order sync not fully implemented
        res.json({ success: true, message: 'Sync started' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Helper: Start auto polling
function startAutoPolling() {
    const configPath = path.join(__dirname, '..', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const intervalMinutes = config.polling_interval_minutes || 5;
    
    logger.log(`Starting auto-polling every ${intervalMinutes} minutes`);
    
    pollingInterval = setInterval(async () => {
        if (!monitorState.autoMode) return;
        
        try {
            monitorState.isPolling = true;
            monitorState.lastCheck = new Date().toISOString();
            
            const Monitor = require('../src/monitor');
            const monitor = new Monitor();
            await monitor.checkDeals();
            
            monitorState.isPolling = false;
        } catch (error) {
            monitorState.isPolling = false;
            logger.error('Auto-check failed: ' + error.message);
        }
    }, intervalMinutes * 60 * 1000);
    
    monitorState.isPolling = true;
}

app.listen(PORT, () => {
    console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
