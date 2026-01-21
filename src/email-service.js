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

