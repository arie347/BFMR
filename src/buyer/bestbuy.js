const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

puppeteer.use(StealthPlugin());

class BestBuyBuyer {
    constructor() {
        this.browser = null;
        this.page = null;
        // Load config
        const configPath = path.join(__dirname, '../../config.json');
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    /**
     * Extract SKU from Best Buy URL
     */
    extractSKU(url) {
        // Match patterns like /6575101.p or skuId=6575101
        const skuMatch = url.match(/\/(\d{7})\.p/) || url.match(/skuId=(\d+)/);
        return skuMatch ? skuMatch[1] : null;
    }

    /**
     * Fetch HTML via ScraperAPI (free tier: 5,000 requests/month)
     * Uses search page approach since product pages get blocked
     */
    async fetchWithScraperAPI(url) {
        const apiKey = this.config.retailer_settings?.bestbuy?.scraper_api_key;
        if (!apiKey) return null;

        // Extract SKU and use search page (more reliable than product pages)
        const sku = this.extractSKU(url);
        if (!sku) {
            console.log('   ⚠️ Could not extract SKU from URL');
            return null;
        }

        // Search by SKU - this works better than product pages via ScraperAPI
        const searchUrl = `https://www.bestbuy.com/site/searchpage.jsp?st=${sku}&intl=nosplash`;
        const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(searchUrl)}&render=true&country_code=us`;
        
        console.log(`   🔍 Searching Best Buy for SKU: ${sku}`);
        
        return new Promise((resolve, reject) => {
            const req = http.get(scraperUrl, { timeout: 90000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }

    /**
     * Parse Best Buy search results HTML to extract price, stock, and product info
     * Works with search results page (more reliable via ScraperAPI)
     */
    parseProductHTML(html) {
        let price = null;
        let inStock = false;
        let title = '';
        let shipsToHome = false;
        let condition = 'new';

        const htmlLower = html.toLowerCase();

        // For search results, look for first product listing with price
        // Search results have product cards with prices in format "$XXX.XX"
        
        // Extract title from first product in search results
        const titleMatch = html.match(/class="[^"]*sku-title[^"]*"[^>]*>.*?<a[^>]*>(.*?)<\/a>/is) ||
                          html.match(/class="[^"]*sku-header[^"]*"[^>]*>(.*?)<\/[^>]+>/is);
        if (titleMatch) {
            title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
        }

        // Find prices - look for the main product price (usually $XX.XX or $XXX.XX format)
        // Search results show prices like "$249.99" prominently
        const priceMatches = html.match(/\$(\d{1,4}\.\d{2})/g);
        if (priceMatches && priceMatches.length > 0) {
            // Filter to reasonable product prices (not $0.99 accessories or $9999 bundles)
            const validPrices = priceMatches
                .map(p => parseFloat(p.replace('$', '').replace(',', '')))
                .filter(p => p >= 10 && p <= 5000);
            
            if (validPrices.length > 0) {
                // First valid price is usually the main product
                price = validPrices[0];
            }
        }

        // Check stock - search results show "Add to Cart" for in-stock items
        if (htmlLower.includes('add to cart') || htmlLower.includes('addtocart')) {
            inStock = true;
        }
        // Search results show "Sold Out" for unavailable items
        if (htmlLower.includes('sold out') || htmlLower.includes('coming soon')) {
            inStock = false;
        }

        // Check shipping - search results often show "Get it by" or "Free shipping"
        if (htmlLower.includes('ships to') || htmlLower.includes('free shipping') ||
            htmlLower.includes('get it by') || htmlLower.includes('delivery') ||
            htmlLower.includes('shipping')) {
            shipsToHome = true;
        }
        // If we found a product with price, assume it ships
        if (price && inStock) shipsToHome = true;

        // Check condition - only mark used if explicitly in title
        if (title.toLowerCase().includes('open-box') || 
            title.toLowerCase().includes('refurbished') ||
            title.toLowerCase().includes('renewed')) {
            condition = 'used';
        }

        return { price, inStock, shipsToHome, condition, title };
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
            headless: 'new', // Use new headless mode (harder to detect)
            defaultViewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1280,800'
            ],
            userDataDir: userDataDir
        });
    }

    /**
     * Validate a Best Buy product - check price, stock, and condition
     * Uses ScraperAPI if configured (free tier: 5,000 requests/month)
     * Falls back to Puppeteer if no API key is set
     * 
     * @param {string} url - Best Buy product URL
     * @param {number} bfmrRetailPrice - Expected retail price from BFMR
     * @returns {object} - { valid: boolean, reason?: string, bestbuyPrice?: number, inStock?: boolean }
     */
    async validateProduct(url, bfmrRetailPrice) {
        const scraperApiKey = this.config.retailer_settings?.bestbuy?.scraper_api_key;
        
        // Try ScraperAPI first if key is configured (FREE: 5,000 req/month)
        if (scraperApiKey) {
            return this.validateWithScraperAPI(url, bfmrRetailPrice);
        }
        
        // Fall back to Puppeteer (may get blocked by Best Buy)
        return this.validateWithPuppeteer(url, bfmrRetailPrice);
    }

    /**
     * Validate using ScraperAPI (free, reliable, anti-bot bypass)
     */
    async validateWithScraperAPI(url, bfmrRetailPrice) {
        console.log(`   🔍 Validating Best Buy (via ScraperAPI): ${url}`);
        
        try {
            const html = await this.fetchWithScraperAPI(url);
            if (!html) {
                return { valid: false, reason: 'scraper_api_error' };
            }

            const productData = this.parseProductHTML(html);
            
            console.log(`   📦 Best Buy: ${productData.title?.substring(0, 50) || '(no title)'}...`);
            console.log(`   💰 Price: $${productData.price || 'NOT FOUND'}`);
            console.log(`   📦 In Stock: ${productData.inStock}`);
            console.log(`   🚚 Ships to Home: ${productData.shipsToHome}`);

            // Validate - same logic as Puppeteer version
            if (!productData.price) {
                return { valid: false, reason: 'price_detection_failed' };
            }

            if (productData.condition === 'used') {
                return { valid: false, reason: 'used_or_renewed' };
            }

            if (!productData.inStock) {
                return { valid: false, reason: 'out_of_stock' };
            }

            const shippingOnly = this.config.retailer_settings?.bestbuy?.shipping_only !== false;
            if (shippingOnly && !productData.shipsToHome) {
                return { valid: false, reason: 'no_shipping' };
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

            return {
                valid: true,
                bestbuyPrice: productData.price,
                inStock: productData.inStock,
                title: productData.title
            };

        } catch (error) {
            console.error('   ❌ ScraperAPI error:', error.message);
            return { valid: false, reason: 'scraper_api_error', message: error.message };
        }
    }

    /**
     * Validate using Puppeteer (may get blocked by Best Buy's anti-bot)
     */
    async validateWithPuppeteer(url, bfmrRetailPrice) {
        if (!this.browser) await this.init();

        let page = null;
        try {
            page = await this.browser.newPage();
            
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            console.log(`   🔍 Validating Best Buy (Puppeteer): ${url}`);
            console.log(`   ⚠️ Note: Set scraper_api_key in config for reliable Best Buy validation`);
            
            // Extra stealth: remove webdriver property
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 45000
            });

            // Wait longer for JS to render prices
            await new Promise(r => setTimeout(r, 4000));

            // Check if we hit a CAPTCHA or blocking page
            const pageContent = await page.content();
            if (pageContent.includes('Please verify you are a human') || 
                pageContent.includes('Access Denied') ||
                pageContent.includes('robot')) {
                console.log('   ⚠️ Best Buy bot detection triggered');
                return { valid: false, reason: 'bot_detected' };
            }

            // Take screenshot for debugging
            await page.screenshot({ path: 'bestbuy-debug.png' });
            console.log('   📸 Screenshot saved to bestbuy-debug.png');

            // Extract product data
            const productData = await page.evaluate(() => {
                let price = null;
                let inStock = false;
                let condition = 'new';
                let title = '';
                let debugInfo = {};

                // Get title
                const titleEl = document.querySelector('.sku-title h1, [data-testid="product-title"], h1');
                if (titleEl) title = titleEl.innerText.trim();
                debugInfo.title = title;

                // Get price - Best Buy has various price selectors (2025 updated)
                const priceSelectors = [
                    '[data-testid="customer-price"] span',
                    '[data-testid="customer-price"]',
                    '.priceView-customer-price span',
                    '.priceView-customer-price',
                    '.priceView-hero-price span',
                    '.priceView-hero-price',
                    '[class*="customerPrice"] span',
                    '[class*="customerPrice"]',
                    '.pricing-price__regular-price',
                    '[data-testid="price"]',
                    '.price-box',
                    // Broader fallback - look for any price on the page
                    '[class*="price"]'
                ];

                debugInfo.selectorsFound = [];
                for (const selector of priceSelectors) {
                    const priceEl = document.querySelector(selector);
                    if (priceEl) {
                        const priceText = priceEl.innerText;
                        debugInfo.selectorsFound.push({ selector, text: priceText?.substring(0, 50) });
                        // Match price pattern like $437.00 or $1,234.56
                        const priceMatch = priceText.match(/\$\s*([\d,]+\.?\d*)/);
                        if (priceMatch) {
                            price = parseFloat(priceMatch[1].replace(',', ''));
                            debugInfo.matchedSelector = selector;
                            break;
                        }
                    }
                }
                
                // Fallback: search entire page for price pattern
                if (!price) {
                    const pageText = document.body.innerText;
                    // Look for "Your price $XXX" or similar
                    const fallbackMatch = pageText.match(/(?:Your price|Price|Now)\s*\$\s*([\d,]+\.?\d*)/i);
                    if (fallbackMatch) {
                        price = parseFloat(fallbackMatch[1].replace(',', ''));
                        debugInfo.matchedFallback = fallbackMatch[0];
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

                return { price, inStock, shipsToHome, condition, title, debugInfo };
            });

            console.log(`   📦 Best Buy: ${productData.title?.substring(0, 50) || '(no title)'}...`);
            console.log(`   💰 Price: $${productData.price || 'NOT FOUND'}`);
            console.log(`   📦 In Stock: ${productData.inStock}`);
            console.log(`   🚚 Ships to Home: ${productData.shipsToHome}`);
            
            // Debug info if price not found
            if (!productData.price && productData.debugInfo) {
                console.log(`   🔍 Debug: Found ${productData.debugInfo.selectorsFound?.length || 0} price elements`);
                if (productData.debugInfo.selectorsFound?.length > 0) {
                    console.log(`   🔍 First element: ${JSON.stringify(productData.debugInfo.selectorsFound[0])}`);
                }
            }

            // Validate price
            if (!productData.price) {
                await page.close();
                return { valid: false, reason: 'price_detection_failed' };
            }

            // Check if product is used/refurbished
            if (productData.condition === 'used') {
                await page.close();
                return { valid: false, reason: 'used_or_renewed' };
            }

            // Check stock
            if (!productData.inStock) {
                await page.close();
                return { valid: false, reason: 'out_of_stock' };
            }

            // Check shipping (we only want items that ship to home)
            const shippingOnly = this.config.retailer_settings?.bestbuy?.shipping_only !== false;
            if (shippingOnly && !productData.shipsToHome) {
                await page.close();
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
                await page.close();
                return {
                    valid: false,
                    reason: 'price_mismatch',
                    bestbuyPrice: productData.price,
                    bfmrRetailPrice: bfmrRetailPrice,
                    maxAllowedPrice: maxAllowedPrice
                };
            }

            // All checks passed!
            await page.close();
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

