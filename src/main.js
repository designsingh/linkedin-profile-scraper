import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseProfile } from './parsers.js';
import { normalizeProfileUrl, extractSlug, randomDelay, isLoginWall } from './utils.js';

// Enable stealth mode — patches webdriver, chrome.runtime, navigator.plugins,
// WebGL, canvas fingerprinting, iframe contentWindow, and more.
chromium.use(stealthPlugin());

await Actor.init();

// ── Input ──────────────────────────────────────────────────────────────
const input = await Actor.getInput() || {};
const {
    profileUrls = [],
    includeExperience = true,
    includeEducation = true,
    includeSkills = false,
    slowMode = false,
    maxConcurrency = 5,
    proxyConfiguration: proxyConfig,
    cookie = '',
} = input;

if (!profileUrls.length) {
    log.error('No profile URLs provided. Add at least one LinkedIn profile URL.');
    await Actor.exit({ exitCode: 1 });
}

// ── Normalize & dedupe URLs ────────────────────────────────────────────
const seen = new Set();
const requests = [];

for (const raw of profileUrls) {
    const url = normalizeProfileUrl(raw);
    if (!url) {
        log.warning(`Skipping invalid input: "${raw}"`);
        continue;
    }
    const slug = extractSlug(url);
    if (seen.has(slug)) {
        log.info(`Skipping duplicate: ${slug}`);
        continue;
    }
    seen.add(slug);
    requests.push({ url, userData: { slug } });
}

log.info(`Processing ${requests.length} unique profiles (from ${profileUrls.length} inputs)`);

// ── Proxy ──────────────────────────────────────────────────────────────
// Force residential + US country for best results against LinkedIn.
let proxy;
if (proxyConfig) {
    proxy = await Actor.createProxyConfiguration({
        ...proxyConfig,
        countryCode: proxyConfig.countryCode || 'US',
    });
} else {
    // Fallback: try to use Apify proxy even if not configured
    try {
        proxy = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        });
    } catch {
        log.warning('No proxy configuration available. Running without proxy (will likely be blocked).');
    }
}

// ── Stats ──────────────────────────────────────────────────────────────
let successCount = 0;
let loginWallCount = 0;
let errorCount = 0;

// ── Crawler ────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: slowMode ? Math.min(maxConcurrency, 2) : maxConcurrency,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,

    // Use playwright-extra with stealth plugin as the launcher
    launchContext: {
        launcher: chromium,
        launchOptions: {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
            ],
        },
    },

    // Disable Crawlee's built-in fingerprints when using stealth plugin
    // to avoid conflicts between the two fingerprinting systems.
    browserPoolOptions: {
        useFingerprints: false,
    },

    // Session pool: rotates proxy + cookies on each retry so LinkedIn
    // sees a different "browser" fingerprint after a 999 block.
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 3,
        },
    },

    // Pre-navigation: inject cookie + set headers + realistic delays
    preNavigationHooks: [
        async ({ page, request }) => {
            const context = page.context();

            // Inject li_at cookie if provided — gives access to unmasked job titles
            if (cookie) {
                log.info(`Setting li_at cookie (${cookie.length} chars) for ${request.userData.slug}`);

                // Set only the li_at cookie — let LinkedIn establish its own
                // session cookies (JSESSIONID, etc.) during navigation.
                // Pre-navigating or faking session cookies causes redirect loops.
                await context.addCookies([
                    {
                        name: 'li_at',
                        value: cookie,
                        domain: '.linkedin.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                        sameSite: 'None',
                    },
                ]);
            }

            // Set realistic headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                ...(cookie ? {} : { 'Referer': 'https://www.google.com/' }),
            });

            // Delay between requests
            if (slowMode) {
                await randomDelay(3000, 6000);
            } else {
                await randomDelay(1500, 3000);
            }
        },
    ],

    async requestHandler({ request, page, response, session }) {
        const { slug } = request.userData;
        const statusCode = response?.status();

        // Log cookie status after navigation
        if (cookie) {
            const pageCookies = await page.context().cookies('https://www.linkedin.com');
            const liAt = pageCookies.find(c => c.name === 'li_at');
            log.info(`[${slug}] Cookie check after navigation: li_at=${liAt ? 'PRESENT' : 'MISSING'}, status=${statusCode}, total_cookies=${pageCookies.length}`);
        }

        // ── Handle 999 (LinkedIn anti-bot block) ───────────────────────
        if (statusCode === 999) {
            session?.retire();
            throw new Error(`LinkedIn returned 999 for ${slug} — session retired, will retry with new proxy`);
        }

        // ── Handle 404 (profile doesn't exist) — don't waste retries ──
        if (statusCode === 404) {
            log.warning(`Profile not found (404) for ${slug} — skipping`);
            await Actor.pushData({
                profileUrl: request.url,
                fullName: '',
                headline: '',
                currentTitle: '',
                currentCompany: '',
                currentCompanyUrl: '',
                location: '',
                about: '',
                profileImageUrl: '',
                experienceCount: 0,
                educationCount: 0,
                followerCount: '',
                connectionCount: '',
                dataQuality: 'not_found',
                loginWallDetected: false,
                scrapedAt: new Date().toISOString(),
            });
            return;
        }

        // ── Handle other non-2xx ───────────────────────────────────────
        if (statusCode && statusCode >= 400) {
            session?.retire();
            throw new Error(`HTTP ${statusCode} for ${slug} — retrying`);
        }

        // Wait for page content to fully load
        await page.waitForLoadState('domcontentloaded');

        // Simulate human-like behavior: small scroll + wait
        await page.mouse.move(300 + Math.random() * 200, 400 + Math.random() * 200);
        await randomDelay(500, 1000);
        await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 200));
        await randomDelay(300, 800);

        const html = await page.content();

        // ── Check for login wall / auth redirect in HTML ───────────────
        if (isLoginWall(html)) {
            log.warning(`Login wall detected for ${slug} (status: ${statusCode})`);
            if (request.retryCount < 3) {
                session?.retire();
                throw new Error(`Login wall for ${slug} — retrying with new session`);
            }
            loginWallCount++;

            await Actor.pushData({
                profileUrl: request.url,
                fullName: '',
                headline: '',
                currentTitle: '',
                currentCompany: '',
                currentCompanyUrl: '',
                location: '',
                about: '',
                profileImageUrl: '',
                experienceCount: 0,
                educationCount: 0,
                followerCount: '',
                connectionCount: '',
                dataQuality: 'blocked',
                loginWallDetected: true,
                scrapedAt: new Date().toISOString(),
            });
            return;
        }

        // ── Parse the profile ──────────────────────────────────────────
        const profile = parseProfile(html, request.url, {
            includeExperience,
            includeEducation,
            includeSkills,
        });

        // Sanity check: if name is empty or is the login page title, the page is garbage
        const isGarbage = !profile.fullName
            || profile.dataQuality === 'minimal'
            || /log\s*in|sign\s*up/i.test(profile.fullName);

        if (isGarbage) {
            if (request.retryCount < 3) {
                session?.retire();
                throw new Error(`Got empty/garbage profile for ${slug} (name: "${profile.fullName}") — retrying`);
            }
            // After retries exhausted, save as blocked
            loginWallCount++;
            await Actor.pushData({
                profileUrl: request.url,
                fullName: '',
                headline: '',
                currentTitle: '',
                currentCompany: '',
                currentCompanyUrl: '',
                location: '',
                about: '',
                profileImageUrl: '',
                experienceCount: 0,
                educationCount: 0,
                followerCount: '',
                connectionCount: '',
                dataQuality: 'blocked',
                loginWallDetected: true,
                scrapedAt: new Date().toISOString(),
            });
            return;
        }

        // Charge event for PPR/PPE billing
        try {
            await Actor.charge({ eventName: 'profile-scraped', count: 1 });
        } catch {
            // Charge API may not be available in all contexts
        }

        await Actor.pushData(profile);
        successCount++;

        session?.markGood();
        log.info(`✓ ${profile.fullName || slug} — ${profile.currentTitle} @ ${profile.currentCompany} [${profile.dataQuality}]`);
    },

    async failedRequestHandler({ request }, error) {
        const { slug } = request.userData;
        errorCount++;
        log.error(`✗ Failed to scrape ${slug} after retries: ${error.message}`);

        await Actor.pushData({
            profileUrl: request.url,
            fullName: '',
            headline: '',
            currentTitle: '',
            currentCompany: '',
            currentCompanyUrl: '',
            location: '',
            about: '',
            profileImageUrl: '',
            experienceCount: 0,
            educationCount: 0,
            followerCount: '',
            connectionCount: '',
            dataQuality: 'failed',
            loginWallDetected: false,
            error: error.message,
            scrapedAt: new Date().toISOString(),
        });
    },
});

// ── Run ────────────────────────────────────────────────────────────────
await crawler.run(requests);

// ── Summary ────────────────────────────────────────────────────────────
log.info('═══════════════════════════════════════');
log.info(`Scraping complete:`);
log.info(`  ✓ Success:    ${successCount}`);
log.info(`  ⚠ Login wall: ${loginWallCount}`);
log.info(`  ✗ Failed:     ${errorCount}`);
log.info(`  Total:        ${requests.length}`);
log.info('═══════════════════════════════════════');

await Actor.exit();
