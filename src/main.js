import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { parseProfile } from './parsers.js';
import { normalizeProfileUrl, extractSlug, randomDelay, isLoginWall } from './utils.js';

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
// Crawlee v3 ProxyConfiguration doesn't accept useApifyProxy; use Apify's helper.
let proxy;
if (proxyConfig) {
    proxy = await Actor.createProxyConfiguration(proxyConfig);
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
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 60,

    // Session pool: rotates proxy + cookies on each retry so LinkedIn
    // sees a different "browser" fingerprint after a 999 block.
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 3,
        },
    },

    // Headless browser config
    headless: true,
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
            ],
        },
    },

    // Pre-navigation: add delays and set realistic browser context
    preNavigationHooks: [
        async ({ page, session }) => {
            // Hide webdriver property to avoid detection
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            // Slow mode: random delay between requests
            if (slowMode) {
                await randomDelay(2000, 5000);
            } else {
                // Even in normal mode, add a small delay to avoid rapid-fire
                await randomDelay(500, 1500);
            }
        },
    ],

    async requestHandler({ request, page, response, session }) {
        const { slug } = request.userData;
        const statusCode = response?.status();

        // ── Handle 999 (LinkedIn anti-bot block) ───────────────────────
        if (statusCode === 999) {
            session?.retire();
            throw new Error(`LinkedIn returned 999 for ${slug} — session retired, will retry with new proxy`);
        }

        // ── Handle other non-2xx ───────────────────────────────────────
        if (statusCode && statusCode >= 400) {
            session?.retire();
            throw new Error(`HTTP ${statusCode} for ${slug} — retrying`);
        }

        // Wait for page content to load
        await page.waitForLoadState('domcontentloaded');

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

        // Sanity check: if we got no name, the page might be garbage
        if (!profile.fullName && profile.dataQuality === 'minimal') {
            if (request.retryCount < 3) {
                session?.retire();
                throw new Error(`Got empty profile for ${slug} — retrying`);
            }
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
