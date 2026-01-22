const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

class EmailService {
    constructor() {
        this.config = this.loadConfig();
        this.resend = null;
        
        if (this.config.email?.resend_api_key) {
            this.resend = new Resend(this.config.email.resend_api_key);
            console.log('✅ Email service initialized with Resend');
        } else if (process.env.RESEND_API_KEY) {
            this.resend = new Resend(process.env.RESEND_API_KEY);
            console.log('✅ Email service initialized with Resend (from env)');
        } else {
            console.log('⚠️ Email service not configured - no RESEND_API_KEY found');
        }
    }

    loadConfig() {
        try {
            const configPath = path.join(__dirname, '..', 'config.json');
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (error) {
            return {};
        }
    }

    getRecipientEmail() {
        return this.config.email?.recipient || process.env.NOTIFICATION_EMAIL || null;
    }

    getSenderEmail() {
        // Resend requires a verified domain or use onboarding@resend.dev for testing
        return this.config.email?.sender || process.env.SENDER_EMAIL || 'BFMR Bot <onboarding@resend.dev>';
    }

    async sendDealNotification(deal, action, retailer, quantity, retailerUrl) {
        if (!this.resend) {
            console.log('📧 Email skipped - service not configured');
            return { success: false, reason: 'not_configured' };
        }

        const recipientEmail = this.getRecipientEmail();
        if (!recipientEmail) {
            console.log('📧 Email skipped - no recipient email configured');
            return { success: false, reason: 'no_recipient' };
        }

        const retailerLabel = retailer === 'bestbuy' ? 'Best Buy' : 'Amazon';
        const isManualAdd = action === 'pending_manual_add';
        
        // Determine subject and content based on action
        let subject, actionText, buttonText, buttonColor;
        
        if (isManualAdd) {
            subject = `🛒 Ready to Add: ${deal.title}`;
            actionText = `Reserved ${quantity} units on BFMR - Ready for manual cart add on ${retailerLabel}`;
            buttonText = `Add to Cart on ${retailerLabel}`;
            buttonColor = retailer === 'bestbuy' ? '#0046be' : '#f0c14b';
        } else if (action === 'added_to_cart') {
            subject = `✅ Added to Cart: ${deal.title}`;
            actionText = `Successfully added ${quantity} units to your Amazon cart`;
            buttonText = 'View on Amazon';
            buttonColor = '#f0c14b';
        } else {
            // Generic success
            subject = `📦 Deal Processed: ${deal.title}`;
            actionText = `Action: ${action} - Quantity: ${quantity}`;
            buttonText = `View on ${retailerLabel}`;
            buttonColor = retailer === 'bestbuy' ? '#0046be' : '#f0c14b';
        }

        const profit = (deal.payout_price - deal.retail_price).toFixed(2);
        const profitPercent = ((profit / deal.retail_price) * 100).toFixed(1);
        const totalProfit = (profit * quantity).toFixed(2);

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5;">
    <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        <!-- Header -->
        <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="margin: 0; font-size: 24px; color: #333;">
                ${isManualAdd ? '🛒' : '✅'} BFMR Deal ${isManualAdd ? 'Ready' : 'Processed'}
            </h1>
        </div>

        <!-- Product -->
        <div style="background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 8px 0; font-size: 18px; color: #333;">${deal.title}</h2>
            <p style="margin: 0; color: #666; font-size: 14px;">
                Code: <strong>${deal.deal_code}</strong> | 
                <span style="background: ${retailer === 'bestbuy' ? '#0046be' : '#f0c14b'}; color: ${retailer === 'bestbuy' ? '#fff' : '#111'}; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${retailerLabel}</span>
            </p>
        </div>

        <!-- Pricing -->
        <div style="display: flex; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
            <div style="text-align: center; flex: 1; min-width: 100px;">
                <div style="font-size: 12px; color: #666;">Retail</div>
                <div style="font-size: 20px; font-weight: bold; color: #333;">$${deal.retail_price}</div>
            </div>
            <div style="text-align: center; flex: 1; min-width: 100px;">
                <div style="font-size: 12px; color: #666;">Payout</div>
                <div style="font-size: 20px; font-weight: bold; color: #10b981;">$${deal.payout_price}</div>
            </div>
            <div style="text-align: center; flex: 1; min-width: 100px;">
                <div style="font-size: 12px; color: #666;">Profit/Unit</div>
                <div style="font-size: 20px; font-weight: bold; color: #10b981;">+$${profit} (${profitPercent}%)</div>
            </div>
        </div>

        <!-- Quantity & Total -->
        <div style="background: #e8f5e9; border-radius: 8px; padding: 16px; margin-bottom: 20px; text-align: center;">
            <div style="font-size: 14px; color: #2e7d32;">Quantity: <strong>${quantity}</strong> | Total Profit: <strong style="font-size: 18px;">+$${totalProfit}</strong></div>
        </div>

        <!-- Status -->
        <div style="background: ${isManualAdd ? '#fff3e0' : '#e3f2fd'}; border-radius: 8px; padding: 16px; margin-bottom: 20px; text-align: center;">
            <p style="margin: 0; color: ${isManualAdd ? '#e65100' : '#1565c0'}; font-size: 14px;">
                ${actionText}
            </p>
        </div>

        <!-- CTA Button -->
        ${retailerUrl ? `
        <div style="text-align: center; margin-bottom: 20px;">
            <a href="${retailerUrl}" target="_blank" style="display: inline-block; background: ${buttonColor}; color: ${retailer === 'bestbuy' ? '#fff' : '#111'}; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; font-size: 16px;">
                ${buttonText}
            </a>
        </div>
        ` : ''}

        <!-- Footer -->
        <div style="text-align: center; color: #999; font-size: 12px; border-top: 1px solid #eee; padding-top: 16px;">
            <p style="margin: 0;">BFMR Auto-Buyer Bot</p>
            <p style="margin: 4px 0 0 0;">
                <a href="https://bfmr.com/deals/${deal.deal_code}" style="color: #3498db;">View on BFMR</a>
            </p>
        </div>
    </div>
</body>
</html>
        `;

        try {
            const { data, error } = await this.resend.emails.send({
                from: this.getSenderEmail(),
                to: recipientEmail,
                subject: subject,
                html: html
            });

            if (error) {
                console.error('📧 Email send error:', error);
                return { success: false, error: error.message };
            }

            console.log(`📧 Email sent successfully: ${subject}`);
            return { success: true, id: data.id };
        } catch (error) {
            console.error('📧 Email error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async sendErrorNotification(dealCode, error, retailer = 'amazon') {
        if (!this.resend) return { success: false, reason: 'not_configured' };

        const recipientEmail = this.getRecipientEmail();
        if (!recipientEmail) return { success: false, reason: 'no_recipient' };

        try {
            const { data, error: sendError } = await this.resend.emails.send({
                from: this.getSenderEmail(),
                to: recipientEmail,
                subject: `⚠️ BFMR Bot Error: ${dealCode}`,
                html: `
                    <div style="font-family: sans-serif; padding: 20px;">
                        <h2>⚠️ Deal Processing Error</h2>
                        <p><strong>Deal Code:</strong> ${dealCode}</p>
                        <p><strong>Retailer:</strong> ${retailer}</p>
                        <p><strong>Error:</strong> ${error}</p>
                        <p style="color: #999; font-size: 12px;">BFMR Auto-Buyer Bot</p>
                    </div>
                `
            });

            if (sendError) {
                console.error('📧 Error notification failed:', sendError);
                return { success: false, error: sendError.message };
            }

            return { success: true, id: data.id };
        } catch (err) {
            console.error('📧 Error notification failed:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Send a summary email with all deals processed in a run
     * @param {Array} results - Array of { deal, action, retailer, quantity, url, success }
     */
    async sendSummaryEmail(results) {
        if (!this.resend) {
            console.log('📧 Summary email skipped - service not configured');
            return { success: false, reason: 'not_configured' };
        }

        const recipientEmail = this.getRecipientEmail();
        if (!recipientEmail) {
            console.log('📧 Summary email skipped - no recipient email configured');
            return { success: false, reason: 'no_recipient' };
        }

        if (!results || results.length === 0) {
            console.log('📧 Summary email skipped - no deals to report');
            return { success: false, reason: 'no_deals' };
        }

        // Categorize results
        const amazonAdded = results.filter(r => r.retailer === 'amazon' && r.success);
        const bestbuyPending = results.filter(r => r.retailer === 'bestbuy' && r.success);
        const failed = results.filter(r => !r.success);

        const totalQuantity = results.filter(r => r.success).reduce((sum, r) => sum + (r.quantity || 0), 0);
        const totalProfit = results.filter(r => r.success).reduce((sum, r) => {
            const profit = (r.deal.payout_price - r.deal.retail_price) * (r.quantity || 0);
            return sum + profit;
        }, 0);

        // Build subject
        let subject = '📦 BFMR Run Summary: ';
        if (amazonAdded.length > 0) subject += `${amazonAdded.length} Amazon `;
        if (bestbuyPending.length > 0) subject += `${bestbuyPending.length} Best Buy `;
        if (amazonAdded.length === 0 && bestbuyPending.length === 0) subject += 'No deals processed';

        // Build HTML
        const renderDealRow = (r) => {
            const profit = (r.deal.payout_price - r.deal.retail_price).toFixed(2);
            const retailerColor = r.retailer === 'bestbuy' ? '#0046be' : '#f0c14b';
            const retailerTextColor = r.retailer === 'bestbuy' ? '#fff' : '#111';
            const retailerLabel = r.retailer === 'bestbuy' ? 'Best Buy' : 'Amazon';
            
            return `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 12px 8px;">
                        <div style="font-weight: 500; color: #333;">${r.deal.title.substring(0, 50)}${r.deal.title.length > 50 ? '...' : ''}</div>
                        <div style="font-size: 12px; color: #666;">${r.deal.deal_code}</div>
                    </td>
                    <td style="padding: 12px 8px; text-align: center;">
                        <span style="background: ${retailerColor}; color: ${retailerTextColor}; padding: 2px 8px; border-radius: 4px; font-size: 11px;">${retailerLabel}</span>
                    </td>
                    <td style="padding: 12px 8px; text-align: center; font-weight: bold;">${r.quantity || 0}</td>
                    <td style="padding: 12px 8px; text-align: right; color: #10b981; font-weight: bold;">+$${profit}</td>
                    <td style="padding: 12px 8px; text-align: center;">
                        ${r.url ? `<a href="${r.url}" style="color: #3b82f6; text-decoration: none;">View</a>` : '-'}
                    </td>
                </tr>
            `;
        };

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; background: #f5f5f5;">
    <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        <!-- Header -->
        <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="margin: 0; font-size: 24px; color: #333;">📦 BFMR Run Summary</h1>
            <p style="margin: 8px 0 0 0; color: #666; font-size: 14px;">${new Date().toLocaleString()}</p>
        </div>

        <!-- Stats -->
        <div style="display: flex; justify-content: space-around; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
            <div style="text-align: center; padding: 16px; background: #f0fdf4; border-radius: 8px; min-width: 120px;">
                <div style="font-size: 28px; font-weight: bold; color: #10b981;">${amazonAdded.length + bestbuyPending.length}</div>
                <div style="font-size: 12px; color: #666;">Deals Processed</div>
            </div>
            <div style="text-align: center; padding: 16px; background: #fef3c7; border-radius: 8px; min-width: 120px;">
                <div style="font-size: 28px; font-weight: bold; color: #f59e0b;">${totalQuantity}</div>
                <div style="font-size: 12px; color: #666;">Total Units</div>
            </div>
            <div style="text-align: center; padding: 16px; background: #dcfce7; border-radius: 8px; min-width: 120px;">
                <div style="font-size: 28px; font-weight: bold; color: #16a34a;">+$${totalProfit.toFixed(2)}</div>
                <div style="font-size: 12px; color: #666;">Potential Profit</div>
            </div>
        </div>

        ${amazonAdded.length > 0 ? `
        <!-- Amazon Section -->
        <div style="margin-bottom: 24px;">
            <h3 style="margin: 0 0 12px 0; padding: 8px 12px; background: #f0c14b; color: #111; border-radius: 6px;">
                🛒 Added to Amazon Cart (${amazonAdded.length})
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <thead>
                    <tr style="background: #f8f9fa;">
                        <th style="padding: 8px; text-align: left;">Product</th>
                        <th style="padding: 8px; text-align: center;">Retailer</th>
                        <th style="padding: 8px; text-align: center;">Qty</th>
                        <th style="padding: 8px; text-align: right;">Profit/Unit</th>
                        <th style="padding: 8px; text-align: center;">Link</th>
                    </tr>
                </thead>
                <tbody>
                    ${amazonAdded.map(renderDealRow).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}

        ${bestbuyPending.length > 0 ? `
        <!-- Best Buy Section -->
        <div style="margin-bottom: 24px;">
            <h3 style="margin: 0 0 12px 0; padding: 8px 12px; background: #0046be; color: #fff; border-radius: 6px;">
                ⏳ Best Buy - Ready for Manual Add (${bestbuyPending.length})
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <thead>
                    <tr style="background: #f8f9fa;">
                        <th style="padding: 8px; text-align: left;">Product</th>
                        <th style="padding: 8px; text-align: center;">Retailer</th>
                        <th style="padding: 8px; text-align: center;">Qty</th>
                        <th style="padding: 8px; text-align: right;">Profit/Unit</th>
                        <th style="padding: 8px; text-align: center;">Link</th>
                    </tr>
                </thead>
                <tbody>
                    ${bestbuyPending.map(renderDealRow).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}

        ${amazonAdded.length === 0 && bestbuyPending.length === 0 ? `
        <div style="text-align: center; padding: 40px; background: #f8f9fa; border-radius: 8px;">
            <p style="margin: 0; color: #666; font-size: 16px;">No deals matched your criteria this run.</p>
        </div>
        ` : ''}

        <!-- Footer -->
        <div style="text-align: center; color: #999; font-size: 12px; border-top: 1px solid #eee; padding-top: 16px; margin-top: 24px;">
            <p style="margin: 0;">BFMR Auto-Buyer Bot</p>
        </div>
    </div>
</body>
</html>
        `;

        try {
            const { data, error } = await this.resend.emails.send({
                from: this.getSenderEmail(),
                to: recipientEmail,
                subject: subject,
                html: html
            });

            if (error) {
                console.error('📧 Summary email error:', error);
                return { success: false, error: error.message };
            }

            console.log(`📧 Summary email sent: ${subject}`);
            return { success: true, id: data.id };
        } catch (error) {
            console.error('📧 Summary email error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async sendTestEmail() {
        if (!this.resend) {
            return { success: false, error: 'Email service not configured. Add RESEND_API_KEY to config or environment.' };
        }

        const recipientEmail = this.getRecipientEmail();
        if (!recipientEmail) {
            return { success: false, error: 'No recipient email configured. Add email.recipient to config.json' };
        }

        try {
            const { data, error } = await this.resend.emails.send({
                from: this.getSenderEmail(),
                to: recipientEmail,
                subject: '✅ BFMR Bot Email Test',
                html: `
                    <div style="font-family: sans-serif; padding: 20px; text-align: center;">
                        <h1>✅ Email Configuration Working!</h1>
                        <p>Your BFMR Auto-Buyer bot is set up to send notifications.</p>
                        <p>You'll receive emails when:</p>
                        <ul style="text-align: left; display: inline-block;">
                            <li>Items are added to your Amazon cart</li>
                            <li>Best Buy items are ready for manual cart add</li>
                        </ul>
                        <p style="color: #999; font-size: 12px; margin-top: 20px;">BFMR Auto-Buyer Bot</p>
                    </div>
                `
            });

            if (error) {
                return { success: false, error: error.message };
            }

            return { success: true, message: `Test email sent to ${recipientEmail}` };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

module.exports = new EmailService();

