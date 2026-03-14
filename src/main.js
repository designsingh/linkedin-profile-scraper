import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
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

if (cookie) {
    log.info(`li_at cookie provided (${cookie.length} chars) — will use authenticated requests`);
}

// ── Proxy ──────────────────────────────────────────────────────────────
let proxy;
if (proxyConfig) {
    proxy = await Actor.createProxyConfiguration({
        ...proxyConfig,
        countryCode: proxyConfig.countryCode || 'US',
    });
} else {
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
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: slowMode ? Math.min(maxConcurrency, 2) : maxConcurrency,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,

    // Session pool: rotates proxy on each retry
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 3,
        },
    },

    // Set headers + cookie before each request
    preNavigationHooks: [
        async ({ request, session }) => {
            const headers = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            };

            if (cookie) {
                headers['Cookie'] = `li_at=${cookie}; lang=v=2&lang=en-us`;
            } else {
                headers['Referer'] = 'https://www.google.com/';
            }

            request.headers = { ...request.headers, ...headers };

            // Delay between requests
            if (slowMode) {
                await randomDelay(3000, 6000);
            } else {
                await randomDelay(1500, 3000);
            }
        },
    ],

    async requestHandler({ request, body, response, session }) {
        const { slug } = request.userData;
        const statusCode = response?.statusCode;
        const html = body;

        log.info(`[${slug}] Got response: status=${statusCode}, body=${html.length} chars`);

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
