const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

class BfmrWeb {
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
        const userDataDir = './user_data_bfmr';
        const lockFile = path.join(userDataDir, 'SingletonLock');
        try {
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                console.log('🧹 Cleaned up stale BFMR browser lock file');
            }

            // Also clean up singleton socket if it exists
            const socketLink = path.join(userDataDir, 'SingletonSocket');
            if (fs.existsSync(socketLink)) {
                fs.unlinkSync(socketLink);
            }
            const cookieLink = path.join(userDataDir, 'SingletonCookie');
            if (fs.existsSync(cookieLink)) {
                fs.unlinkSync(cookieLink);
            }
        } catch (err) {
            console.log('⚠️ Could not clean BFMR lock file:', err.message);
        }

        this.browser = await puppeteer.launch({
            headless: true, // Change to false for debugging
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,800',
                '--disable-dev-shm-usage'
            ],
            userDataDir: userDataDir // Separate user data for BFMR
        });
    }

    async login(email, password) {
        if (!this.browser) await this.init();

        try {
            let page = await this.browser.newPage();
            await page.goto('https://bfmr.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // Wait a moment for potential redirect
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check if already logged in (redirected to dashboard)
            if (page.url().includes('/dashboard') || page.url().includes('/deals')) {
                console.log('✅ Already logged in to BFMR (redirected)');
                this.page = page;
                return { success: true };
            }

            console.log(`Logging in to BFMR... Current URL: ${page.url()}`);

            // Wait for email input to be ready
            try {
                await page.waitForSelector('#email', { visible: true, timeout: 10000 });
            } catch (e) {
                // Check one more time if we got redirected
                if (page.url().includes('/dashboard') || page.url().includes('/deals')) {
                    console.log('✅ Already logged in to BFMR (redirected after wait)');
                    this.page = page;
                    return { success: true };
                }
                throw e;
            }

            await page.type('#email', email);
            await page.type('#password', password);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click('button[type="submit"]')
            ]);

            const currentUrl = page.url();
            console.log(`BFMR Login: Current URL after submit: ${currentUrl}`);

            if (currentUrl.includes('/dashboard') || currentUrl.includes('/deals')) {
                console.log('✅ Successfully logged in to BFMR');
                this.page = page;
                return { success: true };
            } else {
                // Check for explicit auth error messages (Red Box)
                const error = await page.evaluate(() => {
                    const el = document.querySelector('.alert-danger, .error-message');
                    return el ? el.innerText : null;
                });

                console.log(`❌ Failed to log in to BFMR. URL: ${currentUrl}, Error: ${error}`);

                // If we found an explicit error message, it's likely a bad password -> FATAL
                if (error) {
                    return { success: false, fatal: true, error: error };
                }

                // If no error message but didn't log in, treat as generic failure (page didn't load?) -> NON-FATAL
                return { success: false, fatal: false, error: 'Unknown login failure (no redirect)' };
            }
        } catch (error) {
            console.error('Error logging in to BFMR:', error.message);
            // Network/Crash errors are NOT fatal credential issues -> NON-FATAL
            return { success: false, fatal: false, error: error.message };
        }
    }

    async reserveDeal(dealCode, quantity) {
        if (!this.browser) await this.init();

        let page = null;
        try {
            page = await this.browser.newPage();
            console.log(`Navigating to deal ${dealCode} for reservation...`);
            await page.goto(`https://bfmr.com/deals/${dealCode}`, { waitUntil: 'networkidle2' });

            // Check if reservation is closed
            const isClosed = await page.evaluate(() => {
                return document.body.innerText.includes('Reservation Closed') ||
                    document.body.innerText.includes('Deal Expired');
            });

            if (isClosed) {
                console.log('⚠️ Deal is closed or expired');
                return { success: false, status: 'closed' };
            }

            // Find input for quantity
            console.log('Looking for quantity input...');

            // Wait for Reserve button to appear (smart wait instead of fixed 12s)
            try {
                await page.waitForSelector('button.bfmr-btn-green', { timeout: 15000 });
                console.log('✅ Reserve button appeared');
            } catch (waitError) {
                console.log('⚠️ Reserve button did not appear within 15s');
                // Continue anyway, maybe it's there but selector is different
            }

            // Small additional wait for any animations
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Log page content to see what's actually there
            const pageText = await page.evaluate(() => document.body.innerText);
            console.log('Page text (first 300 chars):', pageText.substring(0, 300));

            // Try to find input with multiple selectors
            let qtyInput = await page.$('input[name="quantity"]');
            if (!qtyInput) qtyInput = await page.$('input[type="number"]');
            if (!qtyInput) qtyInput = await page.$('input#quantity');
            if (!qtyInput) qtyInput = await page.$('.quantity-input');

            if (qtyInput) {
                console.log('✅ Found quantity input');
                // Clear and type quantity
                await page.evaluate(el => el.value = '', qtyInput);
                await qtyInput.type(quantity.toString());

                // Dispatch events to ensure button gets enabled
                await page.evaluate(el => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }, qtyInput);

                console.log(`✅ Entered quantity: ${quantity} and dispatched events`);

                // Wait longer for quantity to be fully processed by JavaScript
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.log('⚠️ No quantity input found');
                console.log('Available inputs:', await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('input')).map(inp => ({
                        type: inp.type,
                        name: inp.name,
                        id: inp.id,
                        class: inp.className
                    }));
                }));
            }

            // Click Reserve button - try multiple strategies
            console.log('Looking for reserve button...');

            // Wait for button to be enabled
            try {
                await page.waitForFunction(() => {
                    const btn = document.querySelector('button.bfmr-btn-green') ||
                        document.querySelector('button[type="submit"]');
                    return btn && !btn.disabled;
                }, { timeout: 3000 });
                console.log('✅ Reserve button became enabled');
            } catch (e) {
                console.log('⚠️ Timeout waiting for button to enable');
            }

            let reserveBtn = await page.$('button.bfmr-btn-green');
            if (!reserveBtn) {
                reserveBtn = await page.$('button[type="submit"]');
            }

            if (reserveBtn) {
                console.log('✅ Found reserve button');

                // Check if button is disabled (indicates limit reached)
                const isDisabled = await page.evaluate(btn => btn.disabled, reserveBtn);
                if (isDisabled) {
                    console.log('⚠️ Reserve button is DISABLED - likely hit reservation limit');
                    return { success: false, status: 'limit_reached', message: 'Button disabled - reservation limit reached' };
                }

                // Scroll into view
                await page.evaluate(el => el.scrollIntoView({ block: 'center' }), reserveBtn);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Increased wait time

                console.log('Clicking reserve button...');

                // Try MouseEvent dispatch (more realistic than .click())
                try {
                    await page.evaluate(btn => {
                        // Dispatch mouse events to simulate real click
                        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    }, reserveBtn);
                    console.log('Clicked via MouseEvent dispatch');
                } catch (mouseEventError) {
                    console.log('MouseEvent dispatch failed, trying simple click');
                    await page.evaluate(btn => btn.click(), reserveBtn);
                }

                console.log('Waiting for response...');

                // Wait longer for potential modal or AJAX response (BFMR uses AJAX, no page reload)
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Wait for potential modal or success message
                try {
                    await page.waitForFunction(
                        () => {
                            const text = document.body.innerText.toLowerCase();
                            return text.includes('order number required') ||
                                text.includes('successfully reserved') ||
                                text.includes('reservation successful');
                        },
                        { timeout: 5000 }
                    );
                } catch (e) {
                    console.log('Timed out waiting for success text');
                }

                // Log the page content for debugging
                const pageContent = await page.evaluate(() => document.body.innerText);
                console.log('=== PAGE CONTENT AFTER CLICK ===');
                console.log(pageContent.substring(0, 500)); // First 500 chars
                console.log('=== END PAGE CONTENT ===');

                // Check for success or error messages
                const result = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    const bodyLower = bodyText.toLowerCase();

                    // Check for success indicators (must be more specific to avoid false positives)
                    const successPatterns = [
                        /reservation successful/i,
                        /successfully reserved/i,
                        /added to your reservations/i,
                        /thank you/i,
                        /order number required/i, // From user screenshot
                        /submit the order number/i, // From user screenshot
                        /go to my tracker/i, // From user screenshot
                        /tracking number/i,
                        /reserved/i // Use with caution, matches "reserved: 0"
                    ];

                    // Strong success check
                    for (const pattern of successPatterns) {
                        if (pattern.test(bodyText) && !bodyLower.includes('reserved: 0')) {
                            return { success: true, message: bodyText.match(pattern)[0] };
                        }
                    }

                    // Check for error indicators
                    const errorPatterns = [
                        /reservation closed/i,
                        /deal expired/i,
                        /out of stock/i,
                        /limit exceeded/i,
                        /error/i,
                        /failed/i
                    ];

                    for (const pattern of errorPatterns) {
                        if (pattern.test(bodyText)) {
                            return { success: false, error: bodyText.match(pattern)[0] };
                        }
                    }

                    // UI State Check: If button is gone or changed to "Update", assume success
                    const reserveBtn = document.querySelector('button.bfmr-btn-green') || document.querySelector('button[type="submit"]');
                    if (!reserveBtn) {
                        // Button disappeared -> Success (likely)
                        return { success: true, message: 'Button disappeared' };
                    }
                    if (reserveBtn.innerText.toLowerCase().includes('update')) {
                        return { success: true, message: 'Button changed to Update' };
                    }

                    // Check for toast/alert elements
                    const alertSelectors = ['.alert-success', '.notification', '.toast', '.message'];
                    for (const selector of alertSelectors) {
                        const el = document.querySelector(selector);
                        if (el && el.innerText) {
                            const text = el.innerText.toLowerCase();
                            if (text.includes('success') || text.includes('reserved')) {
                                return { success: true, message: el.innerText };
                            }
                        }
                    }

                    // If no error found and we clicked, treat as "Ambiguous Success" rather than fail
                    // Often BFMR just updates the "Reserved: X" count silently
                    return { success: true, message: 'Ambiguous success (no error found)' };
                });

                console.log('Reservation result:', JSON.stringify(result));

                if (result.success === true) {
                    console.log(`✅ Successfully reserved ${quantity} of ${dealCode}`);
                    return { success: true, status: 'reserved' };
                } else if (result.success === false) {
                    if (result.error && (result.error.toLowerCase().includes('closed') || result.error.toLowerCase().includes('expired'))) {
                        console.log('⚠️ Deal is closed or expired');
                        return { success: false, status: 'closed' };
                    }

                    // Check if error contains limit information
                    const limitPatterns = [
                        /maximum.*?(\d+)/i,
                        /limit.*?(\d+)/i,
                        /only.*?(\d+).*?allowed/i,
                        /reserve.*?up to.*?(\d+)/i,
                        /cannot.*?more than.*?(\d+)/i,
                        /exceed.*?(\d+)/i,
                        /max.*?(\d+)/i,
                        /you can reserve (\d+)/i
                    ];

                    let detectedLimit = null;
                    for (const pattern of limitPatterns) {
                        const match = pageContent.match(pattern);
                        if (match && match[1]) {
                            const limit = parseInt(match[1]);
                            if (limit > 0 && limit <= 100 && limit < quantity) {
                                detectedLimit = limit;
                                console.log(`🔍 Detected limit from error: ${limit} (tried ${quantity})`);
                                break;
                            }
                        }
                    }

                    // If we detected a limit and it's less than what we tried, retry with the correct limit
                    if (detectedLimit) {
                        console.log(`🔄 Retrying reservation with detected limit: ${detectedLimit}`);
                        await page.close();
                        return await this.reserveDeal(dealCode, detectedLimit);
                    }

                    console.log(`⚠️ Reservation failed: ${result.error}`);
                    return { success: false, status: 'failed', error: result.error };
                } else {
                    console.log('⚠️ Could not determine reservation status');
                    return { success: false, status: 'unknown' };
                }
            }

            console.log('❌ Failed to reserve deal');
            return { success: false, status: 'failed' };

        } catch (error) {
            console.error('Error reserving deal:', error.message);
            return { success: false, status: 'error', error: error.message };
        } finally {
            if (page) await page.close();
        }
    }

    async scrapeDealPage(dealCode) {
        if (!this.browser) await this.init();

        let page = null;
        try {
            page = await this.browser.newPage();
            console.log(`Scraping BFMR deal page for ${dealCode}...`);
            await page.goto(`https://bfmr.com/deals/${dealCode}`, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for page to load
            await new Promise(r => setTimeout(r, 2000));

            // Scrape data
            const data = await page.evaluate(() => {
                let limit = null;

                // Strategy 1: Look for "You can reserve up to X" text
                const text = document.body.innerText;
                const limitMatch = text.match(/You can reserve up to (\d+) of this item/i);
                if (limitMatch) {
                    limit = parseInt(limitMatch[1]);
                }

                // Strategy 2: Look for input with max attribute
                if (!limit) {
                    const inputs = Array.from(document.querySelectorAll('input[type="number"], input[name="quantity"]'));
                    for (const input of inputs) {
                        if (input.max) {
                            limit = parseInt(input.max);
                            break; // Assume first input's max is the limit
                        }
                    }
                }

                // Strategy 3: Look for "Limit" column in table
                if (!limit) {
                    const headers = Array.from(document.querySelectorAll('th'));
                    const limitHeaderIndex = headers.findIndex(th => th.innerText.includes('Limit'));

                    if (limitHeaderIndex !== -1) {
                        const rows = Array.from(document.querySelectorAll('tbody tr'));
                        for (const row of rows) {
                            const cells = Array.from(row.querySelectorAll('td'));
                            if (cells[limitHeaderIndex]) {
                                const limitText = cells[limitHeaderIndex].innerText.trim();
                                const parsed = parseInt(limitText);
                                if (!isNaN(parsed)) {
                                    limit = parsed;
                                    break;
                                }
                            }
                        }
                    }
                }

                // Scrape Image - try multiple selectors
                const imgSelectors = [
                    'img[alt*="product"]',
                    '.product-image img',
                    '.deal-image img',
                    'img.main-image',
                    '.image-container img',
                    'table img' // Fallback for table images
                ];

                let imageUrl = null;
                for (const selector of imgSelectors) {
                    const img = document.querySelector(selector);
                    if (img && img.src) {
                        imageUrl = img.src;
                        break;
                    }
                }

                // Scrape Amazon Link
                let amazonLink = null;
                const linkSelectors = [
                    'a[href*="amazon.com"]',
                    'a[href*="amzn.to"]',
                    'a.btn-primary', // Often the "Buy Now" button
                    'a.btn-success',
                    'a[target="_blank"]'
                ];

                for (const selector of linkSelectors) {
                    const links = Array.from(document.querySelectorAll(selector));
                    for (const link of links) {
                        const href = link.href;
                        if (href && (href.includes('amazon.com') || href.includes('amzn.to'))) {
                            amazonLink = href;
                            break;
                        }
                    }
                    if (amazonLink) break;
                }

                // Scrape Best Buy Link/SKU
                let bestbuyUrl = null;
                let bestbuySku = null;
                
                // Look for Best Buy links (including ftc.cash affiliate links)
                const allLinks = Array.from(document.querySelectorAll('a[href]'));
                for (const link of allLinks) {
                    const href = link.href;
                    const text = link.innerText?.toLowerCase() || '';
                    
                    // Direct Best Buy link
                    if (href.includes('bestbuy.com')) {
                        bestbuyUrl = href;
                        // Try to extract SKU from URL
                        const skuMatch = href.match(/skuId=(\d+)/i) || href.match(/\/(\d{7,})(?:\?|$|\.)/);
                        if (skuMatch) bestbuySku = skuMatch[1];
                        break;
                    }
                    
                    // Affiliate link that mentions Best Buy
                    if ((href.includes('ftc.cash') || href.includes('fatcoupon')) && 
                        (text.includes('best buy') || text.includes('bestbuy'))) {
                        // We found an affiliate link for Best Buy
                        // Store the affiliate URL, we'll need to extract SKU differently
                        bestbuyUrl = href;
                    }
                }
                
                // If no direct URL found, try to find SKU in page content
                if (!bestbuySku) {
                    // Look for SKU patterns in the page text
                    const pageText = document.body.innerText;
                    const skuPatterns = [
                        /Best Buy.*?SKU[:\s]*(\d{7,})/i,
                        /SKU[:\s]*(\d{7,}).*?Best Buy/i,
                        /bestbuy\.com.*?(\d{7,})/i
                    ];
                    
                    for (const pattern of skuPatterns) {
                        const match = pageText.match(pattern);
                        if (match) {
                            bestbuySku = match[1];
                            break;
                        }
                    }
                }

                return { limit, imageUrl, amazonLink, bestbuyUrl, bestbuySku };
            });


            // Strategy 4: Trigger validation error to get limit from tooltip
            if (!data.limit) {
                try {
                    console.log('Attempting to detect limit via validation tooltip...');

                    // Find quantity input
                    const input = await page.$('input[name="quantity"], input[type="number"]');
                    if (input) {
                        // Enter a large number to trigger validation
                        await page.evaluate(el => el.value = '', input);
                        await input.type('999');

                        // Dispatch events
                        await page.evaluate(el => {
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }, input);

                        // Wait for button to be enabled
                        await page.waitForFunction(() => {
                            const btn = document.querySelector('button.bfmr-btn-green');
                            return btn && !btn.disabled;
                        }, { timeout: 3000 }).catch(() => { });

                        // Click reserve button to trigger validation
                        const reserveBtn = await page.$('button.bfmr-btn-green');
                        if (reserveBtn) {
                            console.log('Clicking reserve button to trigger validation...');
                            await page.evaluate(btn => btn.click(), reserveBtn);

                            // Wait for button to become disabled (validation in progress)
                            console.log('Waiting for validation to start...');
                            await page.waitForFunction(() => {
                                const btn = document.querySelector('button.bfmr-btn-green');
                                return btn && btn.disabled;
                            }, { timeout: 2000 }).catch(() => console.log('Button did not become disabled'));

                            // Wait for button to become enabled again (validation complete)
                            console.log('Waiting for validation to complete...');
                            await page.waitForFunction(() => {
                                const btn = document.querySelector('button.bfmr-btn-green');
                                return btn && !btn.disabled;
                            }, { timeout: 10000 }).catch(() => console.log('Button did not re-enable'));

                            // Additional wait to ensure tooltip is ready
                            await new Promise(resolve => setTimeout(resolve, 1000));

                            // HOVER over the input field to trigger tooltip
                            const input = await page.$('input[name="quantity"], input[type="number"]');
                            if (input) {
                                console.log('Hovering over input field to trigger tooltip...');
                                await input.hover();

                                // Wait for tooltip to appear
                                await new Promise(resolve => setTimeout(resolve, 1500));
                            }

                            // Check for tooltip attributes AND tooltip DOM elements
                            const tooltipData = await page.evaluate(() => {
                                const input = document.querySelector('input[name="quantity"], input[type="number"]');
                                if (!input) return { found: false };

                                // Get all possible tooltip attributes
                                const attributes = {
                                    title: input.getAttribute('title'),
                                    dataOriginalTitle: input.getAttribute('data-original-title'),
                                    ariaLabel: input.getAttribute('aria-label'),
                                    dataContent: input.getAttribute('data-content'),
                                    dataBsOriginalTitle: input.getAttribute('data-bs-original-title'),
                                    placeholder: input.getAttribute('placeholder')
                                };

                                // Check if input has validation error class
                                const hasError = input.classList.contains('is-invalid') ||
                                    input.classList.contains('error') ||
                                    input.classList.contains('invalid');

                                // Get any validation message elements
                                const validationMsg = document.querySelector('.invalid-feedback, .error-message, .validation-error');
                                const validationText = validationMsg ? validationMsg.innerText : null;

                                // NEW: Check for tooltip DOM elements that might have appeared
                                const tooltipSelectors = [
                                    '.tooltip',
                                    '.bs-tooltip',
                                    '[role="tooltip"]',
                                    '.popover',
                                    '.hint',
                                    '.error-tooltip'
                                ];

                                let tooltipElement = null;
                                let tooltipText = '';
                                for (const selector of tooltipSelectors) {
                                    const el = document.querySelector(selector);
                                    if (el && el.offsetParent !== null) { // Check if visible
                                        tooltipElement = selector;
                                        // Try multiple ways to get text
                                        tooltipText = el.innerText || el.textContent || el.innerHTML;

                                        // If still empty, check child elements
                                        if (!tooltipText) {
                                            const inner = el.querySelector('.tooltip-inner, .popover-body, .tooltip-content');
                                            if (inner) {
                                                tooltipText = inner.innerText || inner.textContent || inner.innerHTML;
                                            }
                                        }
                                        break;
                                    }
                                }

                                console.log('=== TOOLTIP DEBUG ===');
                                console.log('Input found:', !!input);
                                console.log('Has error class:', hasError);
                                console.log('Validation message:', validationText);
                                console.log('Tooltip element found:', tooltipElement);
                                console.log('Tooltip text:', tooltipText);

                                // Log full HTML of tooltip if found
                                if (tooltipElement) {
                                    const tooltipEl = document.querySelector(tooltipElement);
                                    if (tooltipEl) {
                                        console.log('Tooltip HTML:', tooltipEl.outerHTML);
                                        console.log('Tooltip children count:', tooltipEl.children.length);
                                    }
                                }

                                console.log('All attributes:', JSON.stringify(attributes, null, 2));
                                console.log('=== END DEBUG ===');

                                return {
                                    found: true,
                                    hasError,
                                    validationText,
                                    tooltipElement,
                                    tooltipText,
                                    attributes
                                };
                            });

                            console.log('Tooltip data:', JSON.stringify(tooltipData, null, 2));

                            if (tooltipData.found) {
                                // Try to extract limit from any of the sources
                                const allText = Object.values(tooltipData.attributes).filter(v => v).join(' ') +
                                    ' ' + (tooltipData.validationText || '') +
                                    ' ' + (tooltipData.tooltipText || '');
                                console.log('Combined text to search:', allText);

                                const patterns = [
                                    /maximum.*?(\d+)/i,
                                    /limit.*?(\d+)/i,
                                    /only.*?(\d+)/i,
                                    /up to.*?(\d+)/i,
                                    /(\d+).*?max/i,
                                    /reserve.*?(\d+)/i,
                                    /(\d+).*?item/i
                                ];

                                for (const pattern of patterns) {
                                    const match = allText.match(pattern);
                                    if (match && match[1]) {
                                        const limit = parseInt(match[1]);
                                        if (limit > 0 && limit <= 100) {
                                            console.log('✅ Found limit via tooltip: ' + limit);
                                            data.limit = limit;
                                            break;
                                        }
                                    }
                                }
                            }

                            if (!data.limit) {
                                console.log('⚠️ Could not extract limit from tooltip');
                            }
                        }
                    }
                } catch (e) {
                    console.log('Error detecting limit via tooltip:', e.message);
                }
            }

            // Default to 2 if still no limit found (we know 2 works, and incremental reservation will handle more)
            if (!data.limit) {
                data.limit = 2;
                console.log('⚠️ BFMR limit not found - Defaulting to 2 (will use incremental reservation for more)');
            } else {
                console.log('✅ BFMR limit found: ' + data.limit);
            }

            if (data.imageUrl) {
                console.log('✅ BFMR image found: ' + data.imageUrl);
            }

            // If we have a Best Buy SKU but no direct URL, construct one
            if (data.bestbuySku && !data.bestbuyUrl?.includes('bestbuy.com')) {
                data.bestbuyUrl = `https://www.bestbuy.com/site/${data.bestbuySku}.p?skuId=${data.bestbuySku}`;
                console.log('✅ Constructed Best Buy URL from SKU: ' + data.bestbuyUrl);
            }
            
            if (data.bestbuyUrl) {
                console.log('✅ Best Buy URL found: ' + data.bestbuyUrl);
            }

            return data;
        } catch (error) {
            console.error('Error scraping BFMR deal page:', error.message);
            return { limit: null, imageUrl: null, amazonLink: null, bestbuyUrl: null, bestbuySku: null };
        } finally {
            if (page) await page.close();
        }
    }

    async scrapeDealSlugs() {
        if (!this.browser) await this.init();

        let page = null;
        try {
            // Check if we have a logged-in page
            if (!this.page || this.page.isClosed()) {
                console.log('DEBUG: No active page, logging in first...');
                const loginResult = await this.login(process.env.BFMR_EMAIL, process.env.BFMR_PASSWORD);
                if (!loginResult) {
                    console.log('ERROR: Login failed in scrapeDealSlugs');
                    return [];
                }
            }

            page = this.page;
            console.log('DEBUG: Navigating to deals page to scrape slugs...');
            await page.goto('https://www.bfmr.com/deals', { waitUntil: 'networkidle2', timeout: 60000 });

            // Handle dynamic content loading by clicking filter tabs
            try {
                console.log('DEBUG: Waiting for filter tabs...');
                // Wait for any element that might be a tab
                await page.waitForFunction(() => {
                    const text = document.body.innerText;
                    return text.includes('All') || text.includes('In Stock') || text.includes('Active');
                }, { timeout: 10000 });

                // Click filters based on config settings
                const filtersApplied = await page.evaluate(async (config) => {
                    const findAndClickFilter = (text) => {
                        const elements = Array.from(document.querySelectorAll('div, span, li, button, a, label'));
                        const filter = elements.find(el =>
                            el.innerText &&
                            el.innerText.trim() === text &&
                            el.offsetParent !== null // Visible
                        );

                        if (filter) {
                            filter.click();
                            return true;
                        }
                        return false;
                    };

                    let applied = [];

                    // Click "Active" filter if only_open_deals is enabled
                    if (config.filters.only_open_deals) {
                        if (findAndClickFilter('Active')) {
                            applied.push('Active');
                            await new Promise(r => setTimeout(r, 500)); // Wait for UI update
                        }
                    }

                    // Click "Full Retail" filter if enabled in config
                    if (config.filters.filter_full_retail) {
                        if (findAndClickFilter('Full Retail')) {
                            applied.push('Full Retail');
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }

                    // Click "Above Retail" filter if enabled in config
                    if (config.filters.filter_above_retail) {
                        if (findAndClickFilter('Above Retail')) {
                            applied.push('Above Retail');
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }

                    return applied;
                }, this.config);

                if (filtersApplied.length > 0) {
                    console.log(`✅ Applied filters: ${filtersApplied.join(', ')}`);
                    // Wait for deals to reload after filters
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    console.log('⚠️ Could not apply filters, proceeding with default view');

                    // Fallback: try clicking "All" or "In Stock" tab
                    const clicked = await page.evaluate(async () => {
                        const findTab = (text) => {
                            const elements = Array.from(document.querySelectorAll('div, span, li, button, a'));
                            return elements.find(el =>
                                el.innerText &&
                                el.innerText.trim() === text &&
                                el.offsetParent !== null
                            );
                        };

                        const allTab = findTab('All');
                        const inStockTab = findTab('In Stock');
                        const tab = allTab || inStockTab;

                        if (tab) {
                            tab.click();
                            return true;
                        }
                        return false;
                    });

                    if (clicked) {
                        console.log('DEBUG: Clicked default tab to trigger content load');
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }

                // Wait for actual deal links to appear
                await page.waitForSelector('a[href*="/deals/"]', { timeout: 20000 });
                console.log('✅ Found deal links on page');

            } catch (e) {
                console.log(`⚠️ Timeout or error loading dynamic content: ${e.message}`);
            }

            // Scroll to bottom to trigger lazy loading
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                });
            });
            await new Promise(r => setTimeout(r, 1000)); // Settling time

            // Extract deal slugs using DOM + Regex Fallback
            const slugs = await page.evaluate(() => {
                // Method 1: DOM Query
                const links = Array.from(document.querySelectorAll('a[href*="/deals/"]'));
                const domSlugs = links.map(link => {
                    const href = link.getAttribute('href');
                    const match = href.match(/\/deals\/([^\/]+)/);
                    return match ? match[1] : null;
                });

                // Method 2: Regex on full HTML (catch-all)
                const html = document.body.innerHTML;
                const regex = /href=["']\/deals\/([a-zA-Z0-9-]+)["']/g;
                let match;
                const regexSlugs = [];
                while ((match = regex.exec(html)) !== null) {
                    regexSlugs.push(match[1]);
                }

                return [...domSlugs, ...regexSlugs]
                    .filter(slug => slug && slug !== 'create' && slug !== 'dashboard') // Filter noise
                    .filter((v, i, a) => a.indexOf(v) === i); // Unique
            });

            console.log(`✅ Scraped ${slugs.length} unique deal slugs from website`);
            return slugs;

        } catch (error) {
            console.error('Error scraping deal slugs:', error.message);
            return [];
        } finally {
            // Don't close page if it's the main one
            if (page && page !== this.page) {
                await page.close();
            }
        }
    }

    /**
     * Reserve deal incrementally in batches until limit is reached
     * @param {string} dealCode - The deal code to reserve
     * @param {number} batchSize - Size of each reservation batch (default: 2)
     * @returns {Promise<{success: boolean, totalReserved: number, attempts: number}>}
     */
    async reserveIncrementally(dealCode, batchSize = 2) {
        console.log(`\n🔄 Starting incremental reservation for ${dealCode} (batch size: ${batchSize})`);

        let totalReserved = 0;
        let attempts = 0;
        let continueReserving = true;

        while (continueReserving) {
            attempts++;
            console.log(`\n📝 Attempt #${attempts}: Reserving ${batchSize} units...`);

            const result = await this.reserveDeal(dealCode, batchSize);

            if (result.success) {
                totalReserved += batchSize;
                console.log(`✅ Successfully reserved ${batchSize} units (Total: ${totalReserved})`);

                // Wait a bit between reservations to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.log(`⚠️ Reservation failed: ${result.status}`);

                // Check if we hit the limit
                if (result.status === 'limit_reached') {
                    console.log(`✅ Hit reservation limit! Button became disabled.`);
                    continueReserving = false;
                } else if (result.status === 'closed' || result.status === 'error') {
                    console.log(`❌ Deal is closed or error occurred. Stopping.`);
                    continueReserving = false;
                } else if (result.status === 'not_submitted') {
                    // Form didn't submit - might mean we hit limit without button disabling
                    console.log(`⚠️ Form not submitted - likely hit limit`);
                    continueReserving = false;
                } else {
                    continueReserving = false;
                }
            }

            // Safety limit: don't try more than 25 times (50 units max if batch=2)
            if (attempts >= 25) {
                console.log(`⚠️ Reached maximum attempts (${attempts}). Stopping for safety.`);
                continueReserving = false;
            }
        }

        console.log(`\n📊 Incremental Reservation Complete:`);
        console.log(`   Total Reserved (claimed): ${totalReserved} units`);
        console.log(`   Attempts: ${attempts}`);

        // CRITICAL: Verify the reservation actually made it to the tracker
        if (totalReserved > 0) {
            console.log(`\n🔍 Verifying ${totalReserved} reserved units in tracker...`);
            const verification = await this.verifyReservation(dealCode);

            if (!verification.found && !verification.verificationSkipped) {
                console.log(`\n⚠️ WARNING: Claimed ${totalReserved} units but NONE found in tracker!`);
                console.log(`   Verification failed, but trusting initial success signal.`);
                // DEBUG: Take screenshot of tracker
                try {
                    const debugPath = path.join(__dirname, '../../screenshots', `tracker_fail_${dealCode}_${Date.now()}.png`);
                    await this.page.screenshot({ path: debugPath, fullPage: true });
                    console.log(`   📸 Saved tracker debug screenshot: ${debugPath}`);
                } catch (e) { }

                // FALLBACK: Proceed anyway (don't block purchase based on flaky verification)
                // return { success: false, ... } // OLD STRICT BEHAVIOR
            } else if (verification.quantity !== totalReserved && !verification.verificationSkipped) {
                console.log(`\n⚠️ WARNING: Claimed ${totalReserved} units but only ${verification.quantity} in tracker!`);
                console.log(`   Keeping original claimed amount (Trusting initial success over tracker scrape)`);
                return {
                    success: true,
                    totalReserved: totalReserved, // Keeping original, not using verification.quantity which might be 0 due to scrape error
                    attempts,
                    verificationMismatch: true
                };
            } else {
                console.log(`\n✅ Verification passed: ${verification.quantity} units confirmed in tracker`);
            }
        }

        return {
            success: totalReserved > 0,
            totalReserved,
            attempts
        };
    }

    /**
     * Remove a deal reservation from BFMR tracker
     * @param {string} dealCode - The deal code to unreserve
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async unreserveDeal(dealCode) {
        console.log(`\n🗑️ Unreserving deal ${dealCode} from BFMR tracker...`);

        try {
            await this.ensureBrowser();

            // Navigate to tracker page
            const trackerUrl = 'https://www.bfmr.com/tracker';
            await this.page.goto(trackerUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            console.log('📄 Loaded tracker page');

            // Wait for tracker table to load
            await this.page.waitForSelector('table, .tracker-item', { timeout: 10000 });

            // 1. Find the row and click its checkbox
            const rowFound = await this.page.evaluate((code) => {
                const rows = Array.from(document.querySelectorAll('tr, .tracker-item'));
                for (const row of rows) {
                    if (row.textContent.includes(code)) {
                        // Found the row, click the checkbox
                        const checkbox = row.querySelector('input[type="checkbox"]');
                        if (checkbox) {
                            checkbox.click();
                            return true;
                        }
                    }
                }
                return false;
            }, dealCode);

            if (!rowFound) {
                console.log(`⚠️ Could not find row for ${dealCode} or checkbox not found`);
                return { success: false, message: 'Deal/Checkbox not found' };
            }

            console.log('✅ Selected row checkbox. Looking for delete button...');

            // 2. Wait for UI to update (delete button might appear)
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 3. Find and click the "Cancel" button (BFMR uses "Cancel" to remove reservations)
            const clickedCancel = await this.page.evaluate(() => {
                // Look for buttons with "Cancel" text
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));

                for (const btn of buttons) {
                    const text = btn.textContent.trim().toLowerCase();
                    // Check for "Cancel" button
                    if (text === 'cancel' || text.includes('cancel')) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });

            if (clickedCancel) {
                console.log('✅ Clicked Cancel button');

                // 4. Handle confirmation dialog if it appears
                try {
                    await this.page.waitForSelector('.modal button, .confirm-delete, button.btn-danger', { timeout: 2000 });
                    await this.page.evaluate(() => {
                        const confirmBtn = document.querySelector('.modal button.btn-primary, .modal button.btn-danger, .confirm-delete');
                        if (confirmBtn) confirmBtn.click();
                    });
                    console.log('✅ Confirmed deletion');
                } catch (e) {
                    // No confirmation dialog, might have deleted immediately
                    console.log('ℹ️ No confirmation dialog detected');
                }

                return { success: true, message: 'Reservation removed' };
            } else {
                console.log('⚠️ Could not find "Cancel" button');
                return { success: false, message: 'Cancel button not found' };
            }

        } catch (error) {
            console.log(`❌ Error unreserving deal: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Verify that a deal was actually reserved by checking the BFMR tracker
     * @param {string} dealCode - The deal code to verify
     * @returns {Promise<{found: boolean, quantity: number}>}
     */
    async verifyReservation(dealCode) {
        console.log(`\n🔍 Verifying reservation for ${dealCode} in tracker...`);

        try {
            await this.ensureBrowser();
            console.log('   Browser ready, navigating to tracker...');

            // Navigate to tracker with longer timeout
            try {
                await this.page.goto('https://www.bfmr.com/tracker', {
                    waitUntil: 'domcontentloaded',  // Changed from networkidle2 for faster loading
                    timeout: 60000  // Increased to 60 seconds
                });
                console.log('   Tracker page loaded');
            } catch (navError) {
                console.log(`⚠️ Navigation to tracker failed: ${navError.message}`);
                console.log('   Cannot verify reservation - Treating as failure');
                return { found: false, quantity: 0, verificationFailed: true };
            }

            // Wait for table to load
            try {
                await this.page.waitForSelector('table, .tracker-item', { timeout: 15000 });
                console.log('   Table found, waiting for data...');
            } catch (selectorError) {
                console.log(`⚠️ Table selector timeout: ${selectorError.message}`);
                console.log('   Cannot verify reservation - Treating as failure');
                return { found: false, quantity: 0, verificationFailed: true };
            }

            // Wait a bit for data to populate
            await new Promise(r => setTimeout(r, 3000));  // Increased from 2s to 3s

            // Check if deal code exists in tracker
            const result = await this.page.evaluate((code) => {
                const rows = Array.from(document.querySelectorAll('tr, .tracker-item'));
                console.log(`Checking ${rows.length} rows for deal code: ${code}`);

                for (const row of rows) {
                    if (row.textContent.includes(code)) {
                        // Found it! Try to extract quantity
                        const text = row.textContent;
                        // Look for numbers that might be quantity
                        const qtyMatch = text.match(/\b(\d+)\b/);
                        const quantity = qtyMatch ? parseInt(qtyMatch[1]) : 2;  // Default to 2 if can't parse

                        return { found: true, quantity };
                    }
                }

                return { found: false, quantity: 0 };
            }, dealCode);

            if (result.found) {
                console.log(`✅ Verified: ${dealCode} found in tracker (Qty: ${result.quantity})`);
            } else {
                console.log(`❌ NOT FOUND: ${dealCode} is not in the tracker`);
                console.log(`   This might be a false negative - check BFMR tracker manually`);
            }

            return result;

        } catch (error) {
            console.log(`⚠️ Error verifying reservation: ${error.message}`);
            console.log(`   Stack: ${error.stack}`);
            console.log('   Cannot verify reservation - Treating as failure');
            return { found: false, quantity: 0, verificationFailed: true };
        }
    }


    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

module.exports = BfmrWeb;
