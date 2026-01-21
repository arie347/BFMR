const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const logger = require('./src/logger');
const Monitor = require('./src/monitor');
const OrderManager = require('./src/tracker/order-manager');


// Global Error Handlers
process.on('uncaughtException', (error) => {
    console.error('SERVER CRASH (Uncaught Exception):', error);
    if (global.monitor) {
        // Try to verify if we can log to file system
        try {
            const fs = require('fs');
            const path = require('path');
            const logFile = path.join(__dirname, 'logs', 'server.log');
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] [CRITICAL] UNCAUGHT EXCEPTION: ${error.stack}\n`);
        } catch (e) {
            console.error('Failed to write crash to log:', e);
        }
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize Monitor
const monitor = new Monitor();

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard')));

// --- API Endpoints ---

// Get config
app.get('/api/config', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update config
app.post('/api/config', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'config.json');
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Merge new config
        const newConfig = { ...currentConfig, ...req.body };

        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

        // Update monitor config if running
        monitor.config = newConfig;

        logger.log('Config updated via dashboard');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get history (only successful deals)
app.get('/api/history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = logger.getHistory(limit);

        // Filter out deals that have already been ordered
        const filteredHistory = history.filter(deal => !OrderManager.hasDeal(deal.deal_code));

        res.json(filteredHistory);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get logs
app.get('/api/logs', (req, res) => {
    try {
        const logFile = path.join(__dirname, 'logs', 'activity.log');
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

// Get orders (New Endpoint)
app.get('/api/orders', (req, res) => {
    try {
        const orders = OrderManager.getOrders();
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monitor Control: Get Status
app.get('/api/monitor/status', (req, res) => {
    res.json({
        isRunning: monitor.isRunning,
        isPolling: !!monitor.intervalId,
        autoMode: monitor.config.auto_mode !== false
    });
});

// Monitor Control: Set Mode
app.post('/api/monitor/mode', (req, res) => {
    const { auto } = req.body;

    // Update config file to persist preference
    try {
        const configPath = path.join(__dirname, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.auto_mode = auto;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        // Update runtime monitor
        monitor.config.auto_mode = auto;
        monitor.setAutoMode(auto);

        res.json({ success: true, autoMode: auto });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monitor Control: Check Now
app.post('/api/monitor/check', async (req, res) => {
    try {
        await monitor.runOnce(); // Wait for completion
        res.json({ success: true, message: 'Check completed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monitor Control: Sync Orders
app.post('/api/monitor/sync', async (req, res) => {
    try {
        const { isManual } = req.body;
        if (monitor.isSyncing) {
            return res.json({ success: false, message: 'Sync already in progress' });
        }

        // Trigger sync without waiting (fire and forget)
        monitor.syncOrders(isManual).catch(err => {
            console.error('Sync execution error:', err);
        });

        res.json({ success: true, message: 'Order sync started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monitor Control: Retry Deal
app.post('/api/monitor/retry', async (req, res) => {
    try {
        const { deal_code } = req.body;
        if (!deal_code) return res.status(400).json({ error: 'deal_code is required' });

        const result = await monitor.retryDeal(deal_code);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// History: Delete Entry
// Clear History (Mass Delete)
app.delete('/api/history', (req, res) => {
    try {
        const { type } = req.query; // 'missed', 'success', 'all'
        if (!type) {
            return res.status(400).json({ error: 'Type is required (missed, success, all)' });
        }

        const success = logger.clearHistory(type);
        res.json({ success, message: `Cleared ${type} history` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/history/:timestamp', (req, res) => {
    try {
        const { timestamp } = req.params;
        const success = logger.deleteHistoryEntry(timestamp);

        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Entry not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Start Server & Monitor ---

app.listen(PORT, () => {
    console.log(`📊 Dashboard running at http://localhost:${PORT}`);

    // Start monitor (it will respect auto_mode from config)
    monitor.start().catch(error => {
        logger.log(`Fatal monitor error: ${error.message}`, 'ERROR');
    });
});

// Graceful Shutdown
const shutdown = async () => {
    logger.log('\n👋 Shutting down...');
    await monitor.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
