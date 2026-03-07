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
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: slowMode ? Math.min(maxConcurrency, 2) : maxConcurrency,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,

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

    // Tell Crawlee to NOT throw on 999 — let us handle it in requestHandler
    ignoreHttpErrorStatusCodes: [999],

    // got-scraping header ordering matters for TLS fingerprinting
    preNavigationHooks: [
        async ({ request, session }, gotOptions) => {
            // Randomize User-Agent across common Chrome versions
            const chromeVersions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0'];
            const randChrome = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];

            gotOptions.headers = {
                ...gotOptions.headers,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0',
                'Sec-Ch-Ua': `"Chromium";v="${randChrome.split('.')[0]}", "Google Chrome";v="${randChrome.split('.')[0]}", "Not-A.Brand";v="99"`,
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"macOS"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${randChrome} Safari/537.36`,
            };

            // Slow mode: random delay between requests
            if (slowMode) {
                await randomDelay(2000, 5000);
            } else {
                // Even in normal mode, add a small delay to avoid rapid-fire
                await randomDelay(500, 1500);
            }
        },
    ],

    async requestHandler({ request, body, $, response, session }) {
        const { slug } = request.userData;
        const html = typeof body === 'string' ? body : body.toString();
        const statusCode = response?.statusCode;

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
