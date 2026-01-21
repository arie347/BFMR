const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
puppeteer.use(StealthPlugin());

class AmazonBuyer {
    constructor() {
        this.browser = null;
        this.page = null;
        // Load config
        const configPath = path.join(__dirname, '../../config.json');
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    async init(headless = true) {
        if (this.browser) return;

        // Clean up any stale lock files before launching
        const userDataDir = './user_data_new';
        const lockFile = path.join(userDataDir, 'SingletonLock');
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                console.log('🧹 Cleaned up stale browser lock file');
            }
        } catch (err) {
            console.log('⚠️ Could not clean lock file:', err.message);
        }

        this.browser = await puppeteer.launch({
            headless: headless === false ? false : (process.env.HEADLESS !== 'false'),
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,800',
                '--disable-dev-shm-usage', // Helps with memory in Docker/Cloud
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            userDataDir: userDataDir
        });
    }

    async checkLoginStatus() {
        if (!this.browser) {
            await this.init(); // Start in headless mode
        }

        let page = null;
        try {
            page = await this.browser.newPage();
            // Use domcontentloaded instead of networkidle2 for faster, more reliable loading
            // Increase timeout to 60 seconds
            await page.goto('https://www.amazon.com/gp/your-account/order-history', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // Check if redirected to login page
            let url = page.url();
            if (url.includes('signin') || url.includes('ap/signin')) {
                console.log('❌ Not logged in! Restarting browser in visible mode for login...');

                // Close the headless browser
                await page.close();
                await this.browser.close();
                this.browser = null;

                // Restart in non-headless mode
                await this.init(false); // headless = false

                // Open login page in visible browser
                page = await this.browser.newPage();
                await page.goto('https://www.amazon.com/ap/signin', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });

                console.log('🔓 Browser opened for login. Please log in to Amazon...');

                // Wait for user to log in (check URL every second)
                // Timeout after 5 minutes
                const startTime = Date.now();
                while (Date.now() - startTime < 300000) {
                    if (page.isClosed()) return false; // User closed window

                    url = page.url();
                    if (!url.includes('signin') && !url.includes('ap/signin')) {
                        console.log('✅ Detected login! Proceeding...');
                        return true;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }

                console.log('⏰ Login timed out.');
                return false;
            }

            console.log('✅ Logged in to Amazon (headless mode)');
            return true;
        } catch (error) {
            console.error('Error checking login status:', error);
            return false;
        } finally {
            if (page && !page.isClosed()) {
                try {
                    await page.close();
                } catch (e) {
                    // Ignore
                }
            }
        }
    }

    async scrapeBfmrDealPage(dealCode) {
        if (!this.browser) {
            await this.init();
        }

        let page = null;
        try {
            page = await this.browser.newPage();
            console.log(`Fetching BFMR data for ${dealCode}...`);
            await page.goto(`https://bfmr.com/deals/${dealCode}`, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for page to load
            await new Promise(r => setTimeout(r, 2000));

            // Scrape data
            const data = await page.evaluate(() => {
                const text = document.body.innerText;
                const limitMatch = text.match(/You can reserve up to (\d+) of this item/i);
                const limit = limitMatch ? parseInt(limitMatch[1]) : null;

                // Scrape Image
                // Try multiple selectors for the product image
                const img = document.querySelector('.deal-image img, .product-image img, img[alt*="product"], .deal-card img');
                const imageUrl = img ? img.src : null;

                return { limit, imageUrl };
            });

            if (data.limit) {
                console.log(`✅ BFMR limit found: ${data.limit}`);
            } else {
                console.log('⚠️ BFMR limit not found on page');
            }

            if (data.imageUrl) {
                console.log(`✅ BFMR image found: ${data.imageUrl}`);
            }

            return data;
        } catch (error) {
            console.log('Could not fetch BFMR data:', error.message);
            return { limit: null, imageUrl: null };
        } finally {
            if (page && !page.isClosed()) {
                try {
                    await page.close();
                } catch (e) {
                    // Ignore
                }
            }
        }
    }

    /**
     * Validate Amazon product without adding to cart
     * Checks: price, stock availability, and used/renewed status
     * @param {string} url - Amazon product URL
     * @param {number} bfmrRetailPrice - Expected retail price from BFMR
     * @returns {Promise<{valid: boolean, reason?: string, amazonPrice?: number}>}
     */
    async validateProduct(url, bfmrRetailPrice) {
        if (!this.browser || !this.browser.isConnected()) {
            this.browser = null;
            await this.init();
        }

        let page = null;
        try {
            page = await this.browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            console.log(`🔍 Validating product at ${url}...`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            // Wait longer for dynamic content (price) to load
            await new Promise(r => setTimeout(r, 5000));

            // 1. Check price
            const amazonPrice = await page.evaluate(() => {
                const priceSelectors = [
                    '#corePrice_feature_div .a-price .a-offscreen',
                    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
                    '.a-price .a-offscreen',
                    '#priceblock_ourprice',
                    '#priceblock_dealprice',
                    '.a-price-whole',
                    '[data-a-color="price"] .a-offscreen'
                ];

                for (const selector of priceSelectors) {
                    const priceEl = document.querySelector(selector);
                    if (priceEl) {
                        // Check if visible
                        if (priceEl.offsetParent === null && !selector.includes('offscreen')) continue;

                        const priceText = priceEl.textContent.replace(/[^0-9.]/g, '');
                        const price = parseFloat(priceText);
                        if (!isNaN(price) && price > 0) return price;
                    }
                }
                return null;
            });

            if (amazonPrice === null) {
                console.log('⚠️ Could not detect Amazon price');
                return { valid: false, reason: 'price_detection_failed', amazonPrice: null };
            }

            console.log(`   Amazon price: $${amazonPrice}, BFMR retail: $${bfmrRetailPrice}`);

            // Calculate tolerance
            let tolerance = 0;
            if (this.config.price_tolerance && this.config.price_tolerance.enabled) {
                if (this.config.price_tolerance.type === 'dollar') {
                    tolerance = this.config.price_tolerance.value;
                } else if (this.config.price_tolerance.type === 'percent') {
                    tolerance = bfmrRetailPrice * (this.config.price_tolerance.value / 100);
                }
            }

            if (amazonPrice > bfmrRetailPrice + tolerance) {
                console.log(`   ❌ Price mismatch (tolerance: $${tolerance.toFixed(2)})`);
                return { valid: false, reason: 'price_mismatch', amazonPrice, bfmrRetailPrice };
            }

            // 2. Check if used/renewed
            const isUsedOrRenewed = await page.evaluate(() => {
                const title = document.querySelector('#productTitle')?.textContent || '';
                const subtitle = document.querySelector('#productSubtitle')?.textContent || '';
                const condition = document.querySelector('#renewedProgramDescriptionAtf, .a-text-bold')?.textContent || '';
                const keywords = ['renewed', 'refurbished', 'used', 'pre-owned', 'open box', 'certified refurbished'];
                const combinedText = (title + ' ' + subtitle + ' ' + condition).toLowerCase();
                return keywords.some(kw => combinedText.includes(kw));
            });

            if (isUsedOrRenewed) {
                console.log('   ❌ Product is used/renewed/refurbished');
                return { valid: false, reason: 'used_or_renewed' };
            }

            // 3. Check if in stock (Add to Cart button exists)
            const addToCartBtn = await page.$('#add-to-cart-button');
            if (!addToCartBtn) {
                console.log('   ❌ Out of stock (no Add to Cart button)');
                return { valid: false, reason: 'out_of_stock' };
            }

            console.log('   ✅ Validation passed!');
            return { valid: true, amazonPrice };

        } catch (error) {
            console.error('   ❌ Validation error:', error.message);
            return { valid: false, reason: 'error', error: error.message };
        } finally {
            if (page) await page.close();
        }
    }

    async scrapeOrderHistory(days = 30) {
        if (!this.browser) await this.init();

        let page = null;
        try {
            page = await this.browser.newPage();
            console.log('Navigating to Amazon Order History...');

            const filter = days <= 30 ? 'last30' : 'months-6';
            await page.goto(`https://www.amazon.com/your-orders/orders?orderFilter=${filter}`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            console.log('Scraping orders...');
            // Wait for order cards
            await page.waitForSelector('.js-order-card', { timeout: 10000 }).catch(() => console.log('No order cards found immediately'));

            const orders = await page.evaluate(() => {
                const cards = document.querySelectorAll('.js-order-card');
                const results = [];

                cards.forEach(card => {
                    try {
                        const orderId = card.querySelector('.yohtmlc-order-id span, bdo')?.textContent.trim();
                        const date = card.querySelector('.a-color-secondary.value')?.textContent.trim();

                        const itemEls = card.querySelectorAll('.yohtmlc-item');
                        itemEls.forEach(itemEl => {
                            const titleEl = itemEl.querySelector('.a-link-normal, .yohtmlc-product-title');
                            const title = titleEl ? titleEl.textContent.trim() : 'Unknown Item';
                            const link = titleEl ? titleEl.href : null;
                            let asin = null;
                            if (link) {
                                const match = link.match(/\/dp\/([A-Z0-9]{10})/);
                                if (match) asin = match[1];
                            }
                            const trackBtn = card.querySelector('a[href*="track-package"]');
                            const trackingLink = trackBtn ? trackBtn.href : null;
                            const status = card.querySelector('.js-shipment-info-container .a-active')?.textContent.trim() || 'Ordered';

                            results.push({ orderId, date, title, link, asin, trackingLink, status });
                        });
                    } catch (e) { }
                });
                return results;
            });

            console.log(`Scraped ${orders.length} items from order history`);
            return orders;

        } catch (error) {
            console.error('Error scraping order history:', error.message);
            return [];
        } finally {
            if (page) await page.close();
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    async buyItem(url, dealCode = null, bfmrRetailPrice = null, bfmrLimit = null, imageUrl = null) {
        // Ensure browser is initialized
        if (!this.browser || !this.browser.isConnected()) {
            this.browser = null;
            await this.init();
        }

        // If no BFMR data was passed (no credentials), try to scrape without login as fallback
        if (dealCode && !bfmrLimit && !imageUrl) {
            const bfmrData = await this.scrapeBfmrDealPage(dealCode);
            bfmrLimit = bfmrData.limit;
            imageUrl = bfmrData.imageUrl;
        }

        let page = null;

        try {
            page = await this.browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });

            console.log(`Navigating to ${url}...`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait longer for dynamic content (price) to load
            await new Promise(r => setTimeout(r, 5000));

            const currentUrl = page.url();
            console.log(`Current URL: ${currentUrl}`);

            // 1. Scrape Amazon price and validate against BFMR retail price
            if (bfmrRetailPrice) {
                const amazonPrice = await page.evaluate(() => {
                    // Try multiple selectors for price
                    const priceSelectors = [
                        '#corePrice_feature_div .a-price .a-offscreen',
                        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
                        '.a-price .a-offscreen',
                        '#priceblock_ourprice',
                        '#priceblock_dealprice',
                        '.a-price-whole',
                        '[data-a-color="price"] .a-offscreen'
                    ];

                    for (const selector of priceSelectors) {
                        const priceEl = document.querySelector(selector);
                        if (priceEl) {
                            // Check if visible
                            if (priceEl.offsetParent === null && !selector.includes('offscreen')) continue;

                            const priceText = priceEl.textContent.replace(/[^0-9.]/g, '');
                            const price = parseFloat(priceText);
                            if (!isNaN(price) && price > 0) return price;
                        }
                    }
                    return null;
                });

                // If price couldn't be detected, treat as mismatch to avoid accidental purchase
                if (amazonPrice === null) {
                    console.log('⚠️ Could not detect Amazon price - treating as price mismatch');
                    return { success: false, status: 'price_mismatch', amazonPrice: null, bfmrRetailPrice };
                }

                console.log(`Amazon price: $${amazonPrice}, BFMR retail price: $${bfmrRetailPrice}`);

                // Calculate tolerance based on config
                let tolerance = 0;
                if (this.config.price_tolerance && this.config.price_tolerance.enabled) {
                    if (this.config.price_tolerance.type === 'dollar') {
                        tolerance = this.config.price_tolerance.value;
                    } else if (this.config.price_tolerance.type === 'percent') {
                        tolerance = bfmrRetailPrice * (this.config.price_tolerance.value / 100);
                    }
                }

                console.log(`Price tolerance: $${tolerance.toFixed(2)} (${this.config.price_tolerance?.type || 'none'})`);

                if (amazonPrice > bfmrRetailPrice + tolerance) {
                    console.log(`⚠️ Amazon price ($${amazonPrice}) exceeds BFMR retail price ($${bfmrRetailPrice}) beyond tolerance ($${tolerance.toFixed(2)}) - Skipping`);
                    return { success: false, status: 'price_mismatch', amazonPrice, bfmrRetailPrice };
                }
            }

            // 2. Check if product is used/renewed/refurbished
            const isUsedOrRenewed = await page.evaluate(() => {
                const title = document.querySelector('#productTitle')?.textContent || '';
                const subtitle = document.querySelector('#productSubtitle')?.textContent || '';
                const condition = document.querySelector('#renewedProgramDescriptionAtf, .a-text-bold')?.textContent || '';

                // Keywords that indicate used/renewed items
                const keywords = ['renewed', 'refurbished', 'used', 'pre-owned', 'open box', 'certified refurbished'];
                const combinedText = (title + ' ' + subtitle + ' ' + condition).toLowerCase();

                return keywords.some(kw => combinedText.includes(kw));
            });

            if (isUsedOrRenewed) {
                console.log('⚠️ Product is used/renewed/refurbished - Skipping');
                return { success: false, status: 'used_or_renewed' };
            }

            // 3. Check if "Add to Cart" button exists
            const addToCartSelector = '#add-to-cart-button';

            // Wait a bit for dynamic content
            await new Promise(r => setTimeout(r, 3000));

            const addToCartBtn = await page.$(addToCartSelector);

            if (addToCartBtn) {
                // Try to detect and select maximum quantity
                let selectedQuantity = 1; // Default

                try {
                    const qtySelector = '#quantity';
                    const qtyDropdown = await page.$(qtySelector);

                    if (qtyDropdown) {
                        // Get maximum available quantity from dropdown
                        const amazonMaxQty = await page.evaluate((sel) => {
                            const select = document.querySelector(sel);
                            if (!select) return 1;

                            const options = Array.from(select.options);
                            const values = options.map(opt => parseInt(opt.value)).filter(v => !isNaN(v));
                            return values.length > 0 ? Math.max(...values) : 1;
                        }, qtySelector);

                        // Use the minimum of BFMR limit and Amazon max
                        const finalQty = bfmrLimit ? Math.min(bfmrLimit, amazonMaxQty) : amazonMaxQty;

                        console.log(`Amazon max: ${amazonMaxQty}, BFMR limit: ${bfmrLimit || 'N/A'}, Final: ${finalQty}`);

                        // Select final quantity
                        await page.select(qtySelector, finalQty.toString());
                        selectedQuantity = finalQty;
                        console.log(`Selected quantity: ${finalQty}`);
                    } else {
                        console.log('No quantity dropdown found, using default quantity 1');
                    }
                } catch (qtyError) {
                    console.log('Could not detect quantity, using default 1:', qtyError.message);
                }
                // Get initial cart count BEFORE clicking
                const initialCartCount = await page.$eval('#nav-cart-count', el => parseInt(el.innerText)).catch(() => 0);
                console.log(`Initial cart count: ${initialCartCount}`);

                console.log('Found "Add to Cart" button. Clicking...');
                await addToCartBtn.click();

                // Wait for potential warranty/protection plan popup
                await new Promise(r => setTimeout(r, 2500));

                // Handle warranty/protection/upsell popup if it appears
                try {
                    console.log('Checking for upsell/warranty modal...');
                    let dismissed = false;

                    // 1. Try Specific CSS Selectors (Prioritize Known IDs)
                    const closeSelectors = [
                        '#attachSiNoCoverage', // Found in debug HTML
                        'input[aria-labelledby="attachSiNoCoverage-announce"]', // Robust input selector
                        '#attach-close_sideSheet-link',
                        'button[data-action="a-popover-close"]',
                        '#attach-siNoCoverage',
                        '.a-popover-modal .a-button-close',
                        '#siNoCoverage-announce'
                    ];

                    for (const sel of closeSelectors) {
                        const btn = await page.$(sel);
                        if (btn && await btn.boundingBox()) {
                            console.log(`   Dismissing via selector: ${sel}`);
                            await btn.click();
                            dismissed = true;
                            await new Promise(r => setTimeout(r, 1000));
                            break;
                        }
                    }

                    // 2. Fallback: Press Escape key
                    if (!dismissed) {
                        console.log('   Fallback: Pressing Escape key to close potential modal...');
                        try { await page.click('body'); } catch (e) { } // Ensure focus
                        await page.keyboard.press('Escape');
                        await new Promise(r => setTimeout(r, 1000));
                    }

                } catch (warrantyError) {
                    console.log('Error handling warranty popup:', warrantyError.message);
                }

                // Wait for cart confirmation update
                await new Promise(r => setTimeout(r, 2000));

                // DEBUG: Screenshot after attempted dismissal
                try {
                    const debugScreenshotDir = path.join(__dirname, '../../screenshots');
                    if (!fs.existsSync(debugScreenshotDir)) fs.mkdirSync(debugScreenshotDir, { recursive: true });
                    await page.screenshot({ path: path.join(debugScreenshotDir, `post_dismiss_${dealCode}_${Date.now()}.png`) });
                } catch (e) { }

                // VERIFY CART ADDITION
                // Strict check: Success message OR Cart Count increase.

                const successSelector = '#NATC_SMART_WAGON_CONF_MSG_SUCCESS, #huc-v2-order-row-confirm-text, #sw-atc-details-single-container, #sw-atc-confirmation';
                const successMsg = await page.$(successSelector);

                // Check final cart count
                const finalCartCount = await page.$eval('#nav-cart-count', el => parseInt(el.innerText)).catch(() => 0);

                // Success Condition:
                // 1. Explicit Success Message found
                // 2. Cart count INCREASED (Final > Initial)
                // 3. Cart count > 0 is NOT enough if Initial was also > 0 (unless we had 0 initial)

                const countIncreased = finalCartCount > initialCartCount;

                if (successMsg || countIncreased) {
                    console.log(`✅ Verified success (Msg: ${!!successMsg}, Increase: ${countIncreased} [${initialCartCount} -> ${finalCartCount}])`);

                    // Capture screenshot for verification
                    const screenshotDir = path.join(__dirname, '../../screenshots');
                    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
                    const screenshotPath = path.join(screenshotDir, `added_${dealCode}_${Date.now()}.png`);
                    await page.screenshot({ path: screenshotPath });
                    console.log(`📸 Screenshot saved: ${screenshotPath}`);

                    return { success: true, status: 'added_to_cart', url: currentUrl, quantity: selectedQuantity, imageUrl: imageUrl, screenshot: screenshotPath };
                } else {
                    console.log(`⚠️ Verification failed (Msg: ${!!successMsg}, Count: ${initialCartCount} -> ${finalCartCount})`);

                    // Capture failure screenshot AND HTML dump
                    const screenshotDir = path.join(__dirname, '../../screenshots');
                    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

                    const timestamp = Date.now();
                    const debugPath = path.join(screenshotDir, `failed_verify_${dealCode}_${timestamp}.png`);
                    const htmlPath = path.join(screenshotDir, `failed_verify_${dealCode}_${timestamp}.html`);

                    await page.screenshot({ path: debugPath, fullPage: true });
                    fs.writeFileSync(htmlPath, await page.content()); // Save HTML

                    console.log(`📸 Saved debug screenshot: ${debugPath}`);
                    console.log(`📄 Saved debug HTML: ${htmlPath}`);

                    return { success: false, status: 'verification_failed', url: currentUrl };
                }
            } else {
                console.log('   ❌ Could not find "Add to Cart" button. Likely out of stock/unavailable.');
                return { success: false, status: 'out_of_stock', url: currentUrl };
            }
        } catch (error) {
            console.error('Error during purchase flow:', error);
            return { success: false, status: 'error', error: error.message };
        } finally {
            // Close only the page, keep browser open
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    console.log('Error closing page:', e.message);
                }
            }
        }
    }
}

module.exports = AmazonBuyer;
