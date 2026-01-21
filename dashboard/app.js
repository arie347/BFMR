const API_URL = '/api';

// Load configuration
async function loadConfig() {
    try {
        const response = await fetch(`${API_URL}/config`);
        const config = await response.json();

        document.getElementById('polling_interval').value = config.polling_interval_minutes;
        document.getElementById('max_price').value = config.filters.max_price;
        document.getElementById('min_payout').value = config.filters.min_payout;
        document.getElementById('min_profit_margin_percent').value = config.filters.min_profit_margin_percent;
        document.getElementById('only_open_deals').checked = config.filters.only_open_deals !== false;
        document.getElementById('filter_full_retail').checked = config.filters.filter_full_retail !== false;
        document.getElementById('filter_above_retail').checked = config.filters.filter_above_retail !== false;

        if (config.retailer_settings) {
            document.getElementById('enable_amazon').checked = config.retailer_settings.amazon?.enabled !== false;
            document.getElementById('amazon_max_per_order').value = config.retailer_settings.amazon?.max_per_order || 3;
            document.getElementById('enable_bestbuy').checked = config.retailer_settings.bestbuy?.enabled === true; // Default false
            document.getElementById('bestbuy_max_per_order').value = config.retailer_settings.bestbuy?.max_per_order || 2;
        }

        // Load price tolerance
        if (config.price_tolerance) {
            document.getElementById('price_tolerance_enabled').checked = config.price_tolerance.enabled !== false;
            document.getElementById('price_tolerance_type').value = config.price_tolerance.type || 'dollar';
            document.getElementById('price_tolerance_value').value = config.price_tolerance.value || 0;
            toggleToleranceInput();
        }

        if (config.sync_orders) {
            document.getElementById('sync_orders_enabled').checked = config.sync_orders.enabled !== false;
            document.getElementById('sync_interval').value = config.sync_orders.interval_minutes || 30;
        }

    } catch (error) {
        console.error('Error loading config:', error);
    }
}

// Save configuration
async function saveConfig() {
    const config = {
        polling_interval_minutes: parseInt(document.getElementById('polling_interval').value),
        retailer_settings: {
            amazon: { 
                enabled: document.getElementById('enable_amazon').checked,
                max_per_order: parseInt(document.getElementById('amazon_max_per_order').value) || 3
            },
            bestbuy: {
                enabled: document.getElementById('enable_bestbuy').checked,
                max_per_order: parseInt(document.getElementById('bestbuy_max_per_order').value) || 2,
                shipping_only: true
            }
        },
        filters: {
            min_profit_margin_percent: parseFloat(document.getElementById('min_profit_margin_percent').value),
            max_price: parseFloat(document.getElementById('max_price').value),
            min_payout: parseFloat(document.getElementById('min_payout').value),
            preferred_retailers: [], // Deprecated in favor of retailer_settings
            excluded_retailers: [],
            only_open_deals: document.getElementById('only_open_deals').checked,
            filter_full_retail: document.getElementById('filter_full_retail').checked,
            filter_above_retail: document.getElementById('filter_above_retail').checked
        },
        price_tolerance: {
            enabled: document.getElementById('price_tolerance_enabled').checked,
            type: document.getElementById('price_tolerance_type').value,
            value: parseFloat(document.getElementById('price_tolerance_value').value)
        },
        sync_orders: {
            enabled: document.getElementById('sync_orders_enabled').checked,
            interval_minutes: parseInt(document.getElementById('sync_interval').value)
        },
        notifications: {
            desktop_notifications: true,
            sound_on_new_deal: false
        },
        dry_run: true
    };

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const result = await response.json();
        if (result.success) {
            alert('Configuration saved!');
            closeSettings();
        } else {
            alert('Error saving config: ' + result.error);
        }
    } catch (error) {
        console.error('Error saving config:', error);
        alert('Error saving config');
    }
}

async function syncOrdersNow() {
    const btn = document.getElementById('syncNowBtn');
    const status = document.getElementById('syncStatus');

    btn.disabled = true;
    btn.textContent = 'Syncing...';
    status.style.display = 'block';
    status.textContent = 'Starting sync...';
    status.className = 'status-text';

    try {
        const response = await fetch('/api/monitor/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isManual: true })
        });
        const result = await response.json();

        if (result.success) {
            status.textContent = 'Sync started successfully. Check logs for progress.';
            status.style.color = 'green';
        } else {
            status.textContent = 'Error: ' + result.message;
            status.style.color = 'red';
        }
    } catch (error) {
        status.textContent = 'Error triggering sync: ' + error.message;
        status.style.color = 'red';
    } finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Sync Orders Now';
        }, 2000);
    }
}

// Load history
async function loadHistory() {
    try {
        const response = await fetch(`${API_URL}/history`);
        const fullHistory = await response.json();

        // Filter for ONLY successful deals for this section (including pending_manual_add for Best Buy)
        const successStatuses = ['browser_opened', 'added_to_cart', 'added_to_cart_dry_run', 'added_to_cart_no_checkout', 'pending_manual_add'];
        const history = fullHistory.filter(deal => successStatuses.includes(deal.action));

        const historyList = document.getElementById('historyList');

        if (history.length === 0) {
            historyList.innerHTML = '<p class="loading">No successful deals processed yet</p>';
            return;
        }

        historyList.innerHTML = history.map(deal => {
            // Determine retailer
            const retailer = deal.retailer || 
                (deal.bestbuyUrl ? 'bestbuy' : 
                 deal.amazonUrl ? 'amazon' : 'amazon');
            
            const retailerLabel = retailer === 'bestbuy' ? 'Best Buy' : 'Amazon';
            const retailerBadgeStyle = retailer === 'bestbuy' 
                ? 'background: #0046be; color: #fff;' 
                : 'background: #f0c14b; color: #111;';
            
            // Get the appropriate URL
            const url = retailer === 'bestbuy' ? deal.bestbuyUrl : deal.amazonUrl;
            const hasUrl = url && url.startsWith('http');
            
            // Is this a manual add required item?
            const isManualAdd = deal.action === 'pending_manual_add';
            
            return `
            <div class="deal-item">
                <div style="display: flex; gap: 15px;">
                    ${deal.imageUrl ? `<img src="${deal.imageUrl}" alt="${deal.title}" style="width: 80px; height: 80px; object-fit: contain; border-radius: 4px; border: 1px solid #eee;">` : ''}
                    <div style="flex: 1;">
                        <h3 style="margin-top: 0;">${deal.title}</h3>
                        <p>Code: ${deal.deal_code} | Price: $${deal.retail_price} → $${deal.payout_price}</p>
                        <p>
                            <span style="${retailerBadgeStyle} padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">${retailerLabel}</span>
                            ${deal.quantity ? ` <strong style="margin-left: 10px;">${isManualAdd ? '⚠️ Qty to add:' : 'Qty:'} ${deal.quantity}</strong>` : ''}
                            ${isManualAdd ? '<span style="margin-left: 10px; color: #e67e22; font-size: 12px;">(Manual add required)</span>' : ''}
                        </p>
                        <div style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
                            ${hasUrl && isManualAdd && retailer === 'bestbuy' ?
                                `<a href="${url}" target="_blank" class="btn" style="background: linear-gradient(180deg, #0066cc 0%, #0046be 100%); color: #fff; font-weight: 600; padding: 10px 20px; font-size: 14px; border: none; border-radius: 6px; text-decoration: none; box-shadow: 0 2px 4px rgba(0,70,190,0.3);">🛒 Add to Cart on Best Buy</a>` :
                                hasUrl ?
                                `<a href="${url}" target="_blank" class="btn btn-small" style="${retailerBadgeStyle} border: 1px solid ${retailer === 'bestbuy' ? '#003c9e' : '#a88734'};">View on ${retailerLabel}</a>` :
                                `<span style="color: #999; font-size: 12px;">Result: ${deal.result}</span>`
                            }
                            ${deal.bfmrUrl ? `<a href="${deal.bfmrUrl}" target="_blank" class="btn btn-small" style="background: #3498db; color: #fff;">View on BFMR</a>` : ''}
                            <button onclick="deleteMissedDeal('${deal.timestamp}')" class="btn btn-small" style="background: #fee; color: #c0392b; border: 1px solid #fab;">🗑️ Delete</button>
                        </div>
                        <p style="font-size: 11px; color: #999; margin-top: 8px;">${new Date(deal.timestamp).toLocaleString()}</p>
                    </div>
                </div>
            </div>
        `}).join('');
    } catch (error) {
        console.error('Error loading history:', error);
    }
}

// Load Missed Deals (All Failures)
async function loadMissedDeals() {
    try {
        const response = await fetch(`${API_URL}/history`);
        const history = await response.json();

        // Filter for ANY deal that isn't a success, but excluding valid skips
        // Note: pending_manual_add is treated as success (shows in Recent Scrapes, not here)
        const successStatuses = ['browser_opened', 'added_to_cart', 'added_to_cart_dry_run', 'added_to_cart_no_checkout', 'pending_manual_add'];
        const excludedErrors = ['price_mismatch', 'out_of_stock', 'used_or_renewed', 'wrong_retailer'];

        const missedDeals = history.filter(deal =>
            !successStatuses.includes(deal.action) &&
            !excludedErrors.includes(deal.action)
        );

        const listContainer = document.getElementById('missedDealsList');

        if (missedDeals.length === 0) {
            listContainer.innerHTML = '<p class="loading">No missed deals logged</p>';
            return;
        }

        listContainer.innerHTML = missedDeals.map(deal => {
            const retailer = deal.retailer || 'amazon';
            const retailerLabel = retailer === 'bestbuy' ? 'Best Buy' : 'Amazon';
            
            return `
            <div class="deal-item" id="deal-${deal.timestamp}">
                <div class="deal-badge deal-badge-warning">${deal.action}</div>
                <div style="display: flex; gap: 15px; align-items: flex-start;">
                    ${deal.imageUrl ? `<img src="${deal.imageUrl}" alt="${deal.title}" style="width: 80px; height: 80px; object-fit: contain; border-radius: 4px; border: 1px solid #eee;">` : ''}
                    <div style="flex: 1;">
                        <h3 style="margin-top: 0;">${deal.title}</h3>
                        <p>Code: ${deal.deal_code} | BFMR Price: $${deal.retail_price} 
                            <span style="background: ${retailer === 'bestbuy' ? '#0046be' : '#f0c14b'}; color: ${retailer === 'bestbuy' ? '#fff' : '#111'}; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-left: 8px;">${retailerLabel}</span>
                        </p>
                        <p style="color: #e74c3c;"><strong>Error:</strong> ${deal.result}</p>
                        <p style="font-size: 11px; color: #999;">${new Date(deal.timestamp).toLocaleString()}</p>
                        
                        <div style="margin-top: 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                            ${deal.bfmrUrl ? `<a href="${deal.bfmrUrl}" target="_blank" class="btn btn-small" style="background: #3498db; color: #fff;">View on BFMR</a>` : ''}
                            ${deal.amazonUrl ? `<a href="${deal.amazonUrl}" target="_blank" class="btn btn-small" style="background: #f0c14b; color: #111; border: 1px solid #a88734;">View on Amazon</a>` : ''}
                            ${deal.bestbuyUrl ? `<a href="${deal.bestbuyUrl}" target="_blank" class="btn btn-small" style="background: #0046be; color: #fff;">View on Best Buy</a>` : ''}
                            <button onclick="retryDeal('${deal.deal_code}')" class="btn btn-small btn-primary">🔄 Retry Deal</button>
                            <button onclick="deleteMissedDeal('${deal.timestamp}')" class="btn btn-small" style="background: #fee; color: #c0392b; border: 1px solid #fab;">🗑️ Delete</button>
                        </div>
                    </div>
                </div>
            </div>
        `}).join('');
    } catch (error) {
        console.error('Error loading missed deals:', error);
    }
}

async function clearHistory(type) {
    if (!confirm(`Are you sure you want to delete ALL ${type} deals? This cannot be undone.`)) return;

    try {
        const response = await fetch(`${API_URL}/history?type=${type}`, { method: 'DELETE' });
        const result = await response.json();

        if (result.success) {
            if (type === 'missed') {
                loadMissedDeals();
            } else if (type === 'success') {
                loadHistory();
            }
        } else {
            alert('Failed to clear history: ' + result.error);
        }
    } catch (error) {
        console.error('Error clearing history:', error);
    }
}

async function retryDeal(dealCode) {
    if (!confirm('Are you sure you want to retry this deal? It will fetch fresh data from BFMR and attempt to verify/buy.')) return;

    // ... rest of function ...


    try {
        const response = await fetch('/api/monitor/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deal_code: dealCode })
        });
        const result = await response.json();

        if (result.success) {
            alert('Retry started! Check logs for progress.');
        } else {
            alert('Retry failed to start: ' + result.message);
        }
    } catch (error) {
        alert('Error triggering retry: ' + error.message);
    }
}

async function deleteMissedDeal(timestamp) {
    if (!confirm('Hide this error from the list?')) return;

    try {
        const response = await fetch(`/api/history/${timestamp}`, { method: 'DELETE' });
        const result = await response.json();

        if (result.success) {
            // Remove element from DOM immediately
            const el = document.getElementById(`deal-${timestamp}`);
            if (el) el.remove();

            // Check if list is empty
            const list = document.getElementById('missedDealsList');
            if (list.children.length === 0) list.innerHTML = '<p class="loading">No missed deals logged</p>';
        } else {
            alert('Failed to delete: ' + result.error);
        }
    } catch (error) {
        alert('Error deleting entry: ' + error.message);
    }
}

// Load logs
async function loadLogs() {
    try {
        const response = await fetch(`${API_URL}/logs`);
        const logs = await response.json();

        const logsList = document.getElementById('logsList');

        if (logs.length === 0) {
            logsList.innerHTML = '<p class="loading">No logs yet</p>';
            return;
        }

        logsList.innerHTML = logs.map(log => `<div>${log}</div>`).join('');
    } catch (error) {
        console.error('Error loading logs:', error);
    }
}

// Monitor Control
async function updateStatus() {
    try {
        const response = await fetch(`${API_URL}/monitor/status`);
        const status = await response.json();

        const statusBadge = document.getElementById('status');
        const autoToggle = document.getElementById('autoModeToggle');

        autoToggle.checked = status.autoMode;

        if (status.isPolling) {
            statusBadge.textContent = 'Auto-Monitoring';
            statusBadge.style.background = '#10b981'; // Green
        } else {
            statusBadge.textContent = 'Manual Mode';
            statusBadge.style.background = '#f59e0b'; // Orange
        }
    } catch (error) {
        console.error('Error updating status:', error);
    }
}

async function toggleAutoMode() {
    const enabled = document.getElementById('autoModeToggle').checked;
    try {
        await fetch(`${API_URL}/monitor/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auto: enabled })
        });
        updateStatus();
    } catch (error) {
        console.error('Error toggling mode:', error);
        alert('Failed to toggle mode');
    }
}

async function checkNow() {
    const btn = document.getElementById('checkNowBtn');
    // const loader = document.getElementById('loader'); // No longer used
    // const loaderText = document.getElementById('loaderText'); // No longer used

    // Set button to loading state
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    btn.innerHTML = '<div class="spinner"></div> Checking...';

    // Start polling UI updates while processing
    const updateInterval = setInterval(async () => {
        try {
            const historyResponse = await fetch(`${API_URL}/history`);
            const history = await historyResponse.json();
            const count = history.length;

            if (count > 0) {
                btn.innerHTML = `<div class="spinner"></div> Processing... (${count})`;
            } else {
                btn.innerHTML = '<div class="spinner"></div> Processing...';
            }

            await loadHistory();
            await loadLogs();
        } catch (error) {
            console.error('Update error:', error);
        }
    }, 2000); // Update every 2 seconds

    try {
        // This will wait until ALL deals are processed
        await fetch(`${API_URL}/monitor/check`, { method: 'POST' });

        // Processing complete!
        clearInterval(updateInterval);

        // Final update
        await loadHistory();
        await loadLogs();

        // Reset button
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText;

    } catch (error) {
        clearInterval(updateInterval);
        console.error('Error triggering check:', error);
        alert('Failed to trigger check');

        // Reset button on error
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText;
    }
}

// Update tolerance label based on type
function updateToleranceLabel() {
    const type = document.getElementById('price_tolerance_type').value;
    const label = document.getElementById('price_tolerance_label');
    label.textContent = type === 'dollar' ? 'Price Tolerance ($)' : 'Price Tolerance (%)';
}

function toggleToleranceInput() {
    const enabled = document.getElementById('price_tolerance_enabled').checked;
    document.getElementById('price_tolerance_type').disabled = !enabled;
    document.getElementById('price_tolerance_value').disabled = !enabled;
}

// Add event listener for tolerance
document.addEventListener('DOMContentLoaded', () => {
    const typeSelect = document.getElementById('price_tolerance_type');
    if (typeSelect) {
        typeSelect.addEventListener('change', updateToleranceLabel);
    }

    const enabledCheck = document.getElementById('price_tolerance_enabled');
    if (enabledCheck) {
        enabledCheck.addEventListener('change', toggleToleranceInput);
    }
});

// Tab Switching
function switchTab(tabId) {
    // Hide all contents
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    // Show target
    document.getElementById(`${tabId}-view`).classList.add('active');

    // Toggle Header Controls
    if (tabId === 'scraper') {
        document.getElementById('scraper-controls').style.display = 'flex';
        document.getElementById('order-controls').style.display = 'none';
    } else {
        document.getElementById('scraper-controls').style.display = 'none';
        document.getElementById('order-controls').style.display = 'flex';
    }

    // Activate button
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        if (btn.getAttribute('onclick').includes(tabId)) {
            btn.classList.add('active');
        }
    });
}

// Load Orders
async function loadOrders() {
    try {
        const response = await fetch('/api/orders');
        const orders = await response.json();

        const tbody = document.getElementById('ordersTableBody');
        const emptyState = document.getElementById('ordersListEmpty');

        if (!orders || orders.length === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        tbody.innerHTML = orders.map(order => {
            let statusClass = 'status-placed';
            let statusLabel = 'Placed';

            if (order.status === 'TRACKING_FOUND') {
                statusClass = 'status-tracking';
                statusLabel = 'Tracking Found';
            } else if (order.status === 'SYNCED_TO_BFMR') { // Future state
                statusClass = 'status-synced';
                statusLabel = 'Synced';
            }

            // Tracking Link
            const trackingDisplay = order.trackingLink
                ? `<a href="${order.trackingLink}" target="_blank" class="btn-small">Track</a>`
                : '<span style="color:#999">-</span>';

            const bfmrSync = order.bfmrStatus === 'submitted'
                ? '<span style="color:#10b981">✓ submitted</span>'
                : '<span style="color:#f59e0b">pending</span>';

            return `
                <tr>
                    <td>${new Date(order.date).toLocaleDateString()}</td>
                    <td><span style="font-family:monospace">${order.orderId}</span></td>
                    <td>
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${order.imageUrl ? `<img src="${order.imageUrl}" style="width:32px; height:32px; object-fit:contain;">` : ''}
                            <div style="font-size:13px; max-width: 250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                ${order.title}
                            </div>
                        </div>
                    </td>
                    <td><span class="status-tag ${statusClass}">${statusLabel}</span></td>
                    <td>${trackingDisplay}</td>
                    <td>${bfmrSync}</td>
                </tr>
            `;
        }).join('');

    } catch (error) {
        console.error('Error loading orders:', error);
    }
}


// Initialize
loadConfig();
loadHistory();
loadMissedDeals(); // logic updated
loadLogs();
loadOrders(); // New
updateStatus();

// Auto-refresh every 5 seconds (faster for manual mode feedback)
setInterval(() => {
    // Only refresh the active tab's content optionally, or just all?
    // Refreshing all is fine for now.
    loadHistory();
    loadMissedDeals(); // logic updated
    loadLogs();
    loadOrders(); // New
    updateStatus();
}, 5000);

// Settings Modal Logic
function openSettings() {
    const modal = document.getElementById('settingsModal');
    const title = document.getElementById('settingsTitle');
    const scraperForm = document.getElementById('scraperSettingsForm');
    const orderForm = document.getElementById('orderSettingsForm');

    // Determine active tab
    const isScraperActive = document.getElementById('scraper-view').classList.contains('active');

    if (isScraperActive) {
        title.textContent = '⚙️ Scraper Configuration';
        scraperForm.style.display = 'block';
        orderForm.style.display = 'none';
    } else {
        title.textContent = '⚙️ Order Sync Settings';
        scraperForm.style.display = 'none';
        orderForm.style.display = 'block';
    }

    modal.style.display = 'block';
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

// Close modal if clicked outside
window.onclick = function (event) {
    const modal = document.getElementById('settingsModal');
    if (event.target == modal) {
        modal.style.display = 'none';
    }
}


