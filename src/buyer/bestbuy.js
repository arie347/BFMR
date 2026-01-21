const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

class BestBuyBuyer {
    constructor() {
        this.browser = null;
        this.page = null;
        // Load config
        const configPath = path.join(__dirname, '../../config.json');
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    async init() {
        if (this.browser) return;

        // Clean up any stale lock files before launching
        const userDataDir = './user_data_bestbuy';
        const lockFile = path.join(userDataDir, 'SingletonLock');
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                console.log('🧹 Cleaned up stale Best Buy browser lock file');
            }
            // Also clean up singleton socket/cookie if they exist
            const socketLink = path.join(userDataDir, 'SingletonSocket');
            if (fs.existsSync(socketLink)) fs.unlinkSync(socketLink);
            const cookieLink = path.join(userDataDir, 'SingletonCookie');
            if (fs.existsSync(cookieLink)) fs.unlinkSync(cookieLink);
        } catch (err) {
            console.log('⚠️ Could not clean Best Buy lock file:', err.message);
        }

        this.browser = await puppeteer.launch({
            headless: true, // Always headless for Best Buy validation
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,800',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            userDataDir: userDataDir
        });
    }

    /**
     * Validate a Best Buy product - check price, stock, and condition
     * @param {string} url - Best Buy product URL
     * @param {number} bfmrRetailPrice - Expected retail price from BFMR
     * @returns {object} - { valid: boolean, reason?: string, bestbuyPrice?: number, inStock?: boolean }
     */
    async validateProduct(url, bfmrRetailPrice) {
        if (!this.browser) await this.init();

        let page = null;
        try {
            page = await this.browser.newPage();
            
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            console.log(`   🔍 Validating Best Buy product: ${url}`);
            
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Wait for page to load
            await new Promise(r => setTimeout(r, 2000));

            // Check if we hit a CAPTCHA or blocking page
            const pageContent = await page.content();
            if (pageContent.includes('Please verify you are a human') || 
                pageContent.includes('Access Denied') ||
                pageContent.includes('robot')) {
                console.log('   ⚠️ Best Buy bot detection triggered');
                return { valid: false, reason: 'bot_detected' };
            }

            // Extract product data
            const productData = await page.evaluate(() => {
                let price = null;
                let inStock = false;
                let condition = 'new';
                let title = '';

                // Get title
                const titleEl = document.querySelector('.sku-title h1, [data-testid="product-title"], h1');
                if (titleEl) title = titleEl.innerText.trim();

                // Get price - Best Buy has various price selectors
                const priceSelectors = [
                    '[data-testid="customer-price"]',
                    '.priceView-customer-price',
                    '.priceView-hero-price',
                    '[class*="customerPrice"]',
                    '.pricing-price__regular-price',
                    '[data-testid="price"]',
                    '.price-box'
                ];

                for (const selector of priceSelectors) {
                    const priceEl = document.querySelector(selector);
                    if (priceEl) {
                        const priceText = priceEl.innerText;
                        // Match price pattern like $437.00 or $1,234.56
                        const priceMatch = priceText.match(/\$\s*([\d,]+\.?\d*)/);
                        if (priceMatch) {
                            price = parseFloat(priceMatch[1].replace(',', ''));
                            break;
                        }
                    }
                }

                // Check stock status - multiple strategies
                const addToCartBtn = document.querySelector('[data-button-state="ADD_TO_CART"]');
                const soldOutEl = document.querySelector('[data-button-state="SOLD_OUT"]');
                const checkStoresEl = document.querySelector('[data-button-state="CHECK_STORES"]');
                
                // Also check for button text content
                const pageText = document.body.innerText;
                const allButtons = Array.from(document.querySelectorAll('button'));
                const hasAddToCartButton = allButtons.some(b => 
                    b.innerText.toLowerCase().includes('add to cart')
                );
                
                if (addToCartBtn || hasAddToCartButton) {
                    inStock = true;
                } else if (soldOutEl || pageText.includes('Sold Out') || pageText.includes('Coming Soon')) {
                    inStock = false;
                } else if (checkStoresEl || pageText.includes('Check Stores')) {
                    // Available in stores only
                    inStock = false; // We only want shipping
                } else {
                    // If we found a price, assume it's available
                    inStock = price !== null;
                }

                // Check for shipping availability - look for delivery/shipping related text
                const shippingText = document.body.innerText.toLowerCase();
                const shipsToHome = shippingText.includes('ships to') || 
                                    shippingText.includes('free shipping') ||
                                    shippingText.includes('get it by') ||
                                    shippingText.includes('delivery') ||
                                    shippingText.includes('ship to') ||
                                    shippingText.includes('shipping') ||
                                    hasAddToCartButton; // If can add to cart, assume shipping available

                // Check condition (open-box, refurbished, etc.)
                // Only mark as used if the MAIN product is used, not if there's an "Open-Box" option listed
                const lowerTitle = title.toLowerCase();
                const lowerText = document.body.innerText.toLowerCase();
                
                // Check if the product title itself indicates used/refurbished
                if (lowerTitle.includes('open-box') || 
                    lowerTitle.includes('refurbished') || 
                    lowerTitle.includes('pre-owned') ||
                    lowerTitle.includes('renewed') ||
                    lowerTitle.includes('certified')) {
                    condition = 'used';
                }
                // Also check if the page explicitly says this is an open-box item (not just an option)
                else if (lowerText.includes('this is an open-box') || 
                         lowerText.includes('refurbished item') ||
                         lowerText.includes('certified pre-owned')) {
                    condition = 'used';
                }

                return { price, inStock, shipsToHome, condition, title };
            });

            console.log(`   📦 Best Buy: ${productData.title?.substring(0, 50)}...`);
            console.log(`   💰 Price: $${productData.price}`);
            console.log(`   📦 In Stock: ${productData.inStock}`);
            console.log(`   🚚 Ships to Home: ${productData.shipsToHome}`);

            // Validate price
            if (!productData.price) {
                return { valid: false, reason: 'price_detection_failed' };
            }

            // Check if product is used/refurbished
            if (productData.condition === 'used') {
                return { valid: false, reason: 'used_or_renewed' };
            }

            // Check stock
            if (!productData.inStock) {
                return { valid: false, reason: 'out_of_stock' };
            }

            // Check shipping (we only want items that ship to home)
            const shippingOnly = this.config.retailer_settings?.bestbuy?.shipping_only !== false;
            if (shippingOnly && !productData.shipsToHome) {
                return { valid: false, reason: 'no_shipping', message: 'Pickup only, no shipping available' };
            }

            // Check price tolerance
            const tolerance = this.config.price_tolerance || { enabled: false };
            let maxAllowedPrice = bfmrRetailPrice;

            if (tolerance.enabled) {
                if (tolerance.type === 'dollar') {
                    maxAllowedPrice = bfmrRetailPrice + (tolerance.value || 0);
                } else if (tolerance.type === 'percent') {
                    maxAllowedPrice = bfmrRetailPrice * (1 + (tolerance.value || 0) / 100);
                }
            }

            if (productData.price > maxAllowedPrice) {
                return {
                    valid: false,
                    reason: 'price_mismatch',
                    bestbuyPrice: productData.price,
                    bfmrRetailPrice: bfmrRetailPrice,
                    maxAllowedPrice: maxAllowedPrice
                };
            }

            // All checks passed!
            return {
                valid: true,
                bestbuyPrice: productData.price,
                inStock: productData.inStock,
                title: productData.title
            };

        } catch (error) {
            console.error('   ❌ Error validating Best Buy product:', error.message);
            return { valid: false, reason: 'error', message: error.message };
        } finally {
            if (page) await page.close();
        }
    }

    async closeBrowser() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (e) {
                console.log('Error closing Best Buy browser:', e.message);
            }
            this.browser = null;
        }
    }
}

module.exports = BestBuyBuyer;

