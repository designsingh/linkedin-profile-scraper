import { Actor, log } from 'apify';
import { CheerioCrawler, ProxyConfiguration } from 'crawlee';
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
let proxy;
if (proxyConfig) {
    proxy = new ProxyConfiguration(proxyConfig);
}

// ── Stats ──────────────────────────────────────────────────────────────
let successCount = 0;
let loginWallCount = 0;
let errorCount = 0;

// ── Crawler ────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: slowMode ? Math.min(maxConcurrency, 2) : maxConcurrency,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,

    // Mimic a real browser
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }, gotOptions) => {
            gotOptions.headers = {
                ...gotOptions.headers,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Upgrade-Insecure-Requests': '1',
            };

            if (slowMode) {
                await randomDelay(2000, 5000);
            }
        },
    ],

    async requestHandler({ request, body, $, response }) {
        const { slug } = request.userData;
        const html = typeof body === 'string' ? body : body.toString();

        // Check for login wall / auth redirect
        if (isLoginWall(html) || (response?.statusCode && response.statusCode >= 400)) {
            log.warning(`Login wall or block detected for ${slug} (status: ${response?.statusCode})`);
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

        // Parse the profile
        const profile = parseProfile(html, request.url, {
            includeExperience,
            includeEducation,
            includeSkills,
        });

        // Charge event for PPR/PPE billing
        try {
            await Actor.charge({ eventName: 'profile-scraped', count: 1 });
        } catch {
            // Charge API may not be available in all contexts
        }

        await Actor.pushData(profile);
        successCount++;

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
