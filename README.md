# BFMR Auto-Buyer

Automated deal monitoring and purchasing tool for BuyForMeRetail (BFMR).

## Features

- ✅ **BFMR API Integration** - Fetches deals automatically
- ✅ **Smart Filtering** - Configure price limits, profit margins, preferred retailers
- ✅ **Continuous Monitoring** - Polls BFMR every 5 minutes (configurable)
- ✅ **Amazon Automation** - Opens browser to product pages (dry-run mode)
- ✅ **Web Dashboard** - View deals, history, and configure settings
- ✅ **Activity Logging** - Tracks all actions and deal processing

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure API credentials:**
   Edit `.env` file:
   ```
   BFMR_API_KEY=your_api_key
   BFMR_API_SECRET=your_api_secret
   ```

3. **Configure filters:**
   Edit `config.json` to set your preferences:
   - `max_price`: Maximum deal price
   - `min_payout`: Minimum payout amount
   - `min_profit_margin`: Minimum profit required
   - `polling_interval_minutes`: How often to check for deals

## Usage

### Start the Monitor (Continuous Mode)
```bash
node monitor.js
```
This will:
- Check BFMR for deals every 5 minutes
- Open browser for matching deals
- Log all activity to `logs/activity.log`
- Press `Ctrl+C` to stop

### Start the Dashboard
```bash
node dashboard/server.js
```
Then open: http://localhost:3000

### Run Once (Test Mode)
```bash
node src/index.js
```

## Dashboard

The web dashboard provides:
- **Configuration Editor** - Change filters without editing files
- **Deal History** - View all processed deals
- **Activity Logs** - Real-time monitoring logs

## Safety

- **Dry Run Mode**: Currently enabled by default
- Bot opens browser to product page but does NOT complete purchase
- You must manually review and purchase
- To enable auto-purchase (future): Set `dry_run: false` in config.json

## File Structure

```
├── config.json          # User configuration
├── .env                 # API credentials
├── monitor.js           # Main monitoring script
├── src/
│   ├── bfmr-client.js   # BFMR API client
│   ├── deal-manager.js  # Deal filtering logic
│   ├── monitor.js       # Monitoring loop
│   ├── logger.js        # Logging system
│   └── buyer/
│       └── amazon.js    # Amazon automation
├── dashboard/
│   ├── server.js        # Express API server
│   ├── index.html       # Dashboard UI
│   ├── style.css        # Styling
│   └── app.js           # Frontend logic
├── logs/
│   └── activity.log     # Activity logs
└── data/
    └── history.json     # Deal history
```

## Configuration Options

### Filters
- `max_price`: Maximum retail price (default: 10000)
- `min_payout`: Minimum payout amount (default: 0)
- `min_profit_margin`: Minimum profit (payout - retail) (default: 0)
- `only_open_deals`: Skip reservation-closed deals (default: true)
- `preferred_retailers`: List of retailers to target (default: ["Amazon"])

### Monitoring
- `polling_interval_minutes`: Check interval (default: 5)
- `dry_run`: Safety mode - opens browser but doesn't purchase (default: true)

## Troubleshooting

**No deals found:**
- Check your filters in `config.json`
- Try lowering `max_price` or `min_profit_margin`
- Set `only_open_deals: false` to see closed deals

**Browser not opening:**
- Check if another instance is running
- Delete `user_data` folder and try again

**Dashboard not loading:**
- Make sure dashboard server is running: `node dashboard/server.js`
- Check if port 3000 is available
