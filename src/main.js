import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { parseProfile, parseVoyagerProfile, parseEmbeddedVoyagerData } from './parsers.js';
import { normalizeProfileUrl, extractSlug, randomDelay, isLoginWall } from './utils.js';

await Actor.init();

// ── Input ────────────────────────────────────────────────────────────────
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

// ── Normalize & dedupe URLs ──────────────────────────────────────────────
const seen = new Set();
const requests = [];

// Generate a CSRF token for Voyager API requests
const csrfToken = `ajax:${Date.now()}`;

// Track which slugs already have an HTML fallback enqueued
const htmlFallbackEnqueued = new Set();

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

        if (cookie) {
                                // When authenticated, use LinkedIn's Voyager Dash API for structured data
                        const apiUrl = `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${slug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19`;
                                requests.push({
                                                                url: apiUrl,
                                                                userData: { slug, profileUrl: url, useApi: true },
                                });
        } else {
                                // Without cookie, scrape the public profile HTML
                        requests.push({
                                                        url,
                                                        userData: { slug, profileUrl: url, useApi: false },
                        });
        }
}

log.info(`Processing ${requests.length} unique profiles (from ${profileUrls.length} inputs)`);
if (cookie) {
                log.info(`li_at cookie provided (${cookie.length} chars) — using Voyager API for full data`);
}

// ── Proxy ────────────────────────────────────────────────────────────────
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

// ── Stats ────────────────────────────────────────────────────────────────
let successCount = 0;
let loginWallCount = 0;
let errorCount = 0;

// ── Empty result helper ─────────────────────────────────────────────────
function emptyResult(profileUrl, quality, opts = {}) {
                return {
                                        profileUrl,
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
                                        dataQuality: quality,
                                        loginWallDetected: opts.loginWall || false,
                                        error: opts.error || undefined,
                                        scrapedAt: new Date().toISOString(),
                };
}

// ── Helper: enqueue HTML fallback (deduplicated) ────────────────────────
async function enqueueHtmlFallback(slug, profileUrl, reason) {
                if (htmlFallbackEnqueued.has(slug)) {
                                        log.info(`[${slug}] HTML fallback already enqueued — skipping`);
                                        return false;
                }
                htmlFallbackEnqueued.add(slug);
                log.warning(`[${slug}] ${reason} — falling back to public HTML scraping (no cookie)`);
                await crawler.addRequests([{
                                        url: profileUrl,
                                        userData: { slug, profileUrl, useApi: false, skipCookie: true },
                                        uniqueKey: `html-fallback-${slug}`,
                }]);
                return true;
}

// ── Crawler ──────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
                proxyConfiguration: proxy,
                maxConcurrency: slowMode ? Math.min(maxConcurrency, 2) : maxConcurrency,
                maxRequestRetries: 5,
                requestHandlerTimeoutSecs: 60,
                navigationTimeoutSecs: 30,

                // Accept JSON responses from Voyager API
                additionalMimeTypes: ['application/json', 'application/vnd.linkedin.normalized+json+2.1'],

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
                                        async ({ request }) => {
                                                                        const headers = {
                                                                                                                'Accept-Language': 'en-US,en;q=0.9',
                                                                                                                'Cache-Control': 'no-cache',
                                                                                };

                                                if (cookie && request.userData.useApi) {
                                                                                        // Voyager API headers
                                                                                headers['Accept'] = 'application/vnd.linkedin.normalized+json+2.1';
                                                                                        headers['Cookie'] = `li_at=${cookie}; JSESSIONID="${csrfToken}"; lang=v=2&lang=en-us`;
                                                                                        headers['csrf-token'] = csrfToken;
                                                                                        headers['x-li-lang'] = 'en_US';
                                                                                        headers['x-restli-protocol-version'] = '2.0.0';
                                                                                        headers['x-li-track'] = '{"clientVersion":"1.13.8","mpVersion":"1.13.8","osName":"web","timezoneOffset":-5,"timezone":"America/Toronto","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}';
                                                } else if (cookie && !request.userData.useApi && !request.userData.skipCookie) {
                                                                                        // Authenticated HTML page (first-party HTML request, not fallback)
                                                                                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
                                                                                        headers['Cookie'] = `li_at=${cookie}; lang=v=2&lang=en-us`;
                                                } else {
                                                                                        // Public page — no cookie (either no cookie provided, or this is a fallback)
                                                                                headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
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
                                        const { slug, profileUrl, useApi } = request.userData;
                                        const statusCode = response?.statusCode;

                        log.info(`[${slug}] Got response: status=${statusCode}, body=${body.length} chars, api=${useApi}`);

                        // ── Handle error status codes ────────────────────────────────
                        if (statusCode === 999) {
                                                        session?.retire();
                                                        throw new Error(`LinkedIn returned 999 for ${slug} — session retired, will retry with new proxy`);
                        }

                        if (statusCode === 404) {
                                                        log.warning(`Profile not found (404) for ${slug} — skipping`);
                                                        await Actor.pushData(emptyResult(profileUrl, 'not_found'));
                                                        return;
                        }

                        // API auth failures → fall back to public HTML
                        if ((statusCode === 401 || statusCode === 403) && useApi) {
                                                        await enqueueHtmlFallback(slug, profileUrl, `API returned ${statusCode}`);
                                                        return;
                        }

                        if (statusCode === 401 || statusCode === 403) {
                                                        session?.retire();
                                                        throw new Error(`HTTP ${statusCode} for ${slug} — cookie may be expired, retrying`);
                        }

                        // API endpoint deprecated — fall back to HTML scraping
                        if (statusCode === 410 && useApi) {
                                                        await enqueueHtmlFallback(slug, profileUrl, 'API returned 410 Gone');
                                                        return;
                        }

                        if (statusCode && statusCode >= 400) {
                                                        // For API requests, fall back to HTML on any 4xx/5xx
                                                if (useApi) {
                                                                                        await enqueueHtmlFallback(slug, profileUrl, `API returned HTTP ${statusCode}`);
                                                                                        return;
                                                }
                                                        session?.retire();
                                                        throw new Error(`HTTP ${statusCode} for ${slug} — retrying`);
                        }

                        let profile;

                        if (useApi) {
                                                        // ── Parse Voyager API JSON response ──────────────────────
                                                try {
                                                                                        const data = typeof body === 'string' ? JSON.parse(body) : body;
                                                                                        profile = parseVoyagerProfile(data, profileUrl, {
                                                                                                                                        includeExperience,
                                                                                                                                        includeEducation,
                                                                                                                                        includeSkills,
                                                                                                });
                                                                                        log.info(`[${slug}] Voyager API parsed: ${profile.fullName}, title=${profile.currentTitle}`);
                                                } catch (e) {
                                                                                        log.warning(`[${slug}] Failed to parse Voyager API response: ${e.message}`);
                                                }

                                                // If API returned data but parse was empty, fall back to HTML
                                                if (!profile || !profile.fullName) {
                                                                                        await enqueueHtmlFallback(slug, profileUrl,
                                                                                                                                                          `Voyager API returned empty profile (name: "${profile?.fullName || ''}")`);
                                                                                        return;
                                                }
                        } else {
                                                        // ── Parse HTML page ──────────────────────────────────────
                                                const html = body;

                                                if (isLoginWall(html)) {
                                                                                        log.warning(`Login wall detected for ${slug} (status: ${statusCode})`);
                                                                                        if (request.retryCount < 3) {
                                                                                                                                        session?.retire();
                                                                                                                                        throw new Error(`Login wall for ${slug} — retrying with new session`);
                                                                                                }
                                                                                        loginWallCount++;
                                                                                        await Actor.pushData(emptyResult(profileUrl, 'blocked', { loginWall: true }));
                                                                                        return;
                                                }

                                                // If cookie is set and this is NOT a fallback request, try embedded Voyager data
                                                if (cookie && !request.userData.skipCookie) {
                                                                                        const embeddedProfile = parseEmbeddedVoyagerData(html, profileUrl, {
                                                                                                                                        includeExperience,
                                                                                                                                        includeEducation,
                                                                                                                                        includeSkills,
                                                                                                });
                                                                                        if (embeddedProfile && embeddedProfile.fullName && embeddedProfile.dataQuality !== 'minimal') {
                                                                                                                                        profile = embeddedProfile;
                                                                                                                                        log.info(`[${slug}] Parsed embedded Voyager data from HTML`);
                                                                                                }
                                                }

                                                // Fall back to standard HTML parsing (JSON-LD + OG tags)
                                                if (!profile) {
                                                                                        profile = parseProfile(html, profileUrl, {
                                                                                                                                        includeExperience,
                                                                                                                                        includeEducation,
                                                                                                                                        includeSkills,
                                                                                                });
                                                }
                        }

                        // Sanity check
                        const isGarbage = !profile.fullName
                                                || profile.dataQuality === 'minimal'
                                                || /log\s*in|sign\s*up|linkedin/i.test(profile.fullName);

                        if (isGarbage) {
                                                        if (request.retryCount < 3) {
                                                                                                session?.retire();
                                                                                                throw new Error(`Got empty/garbage profile for ${slug} (name: "${profile.fullName}") — retrying`);
                                                        }
                                                        loginWallCount++;
                                                        await Actor.pushData(emptyResult(profileUrl, 'blocked', { loginWall: true }));
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

                // Fall back to HTML on redirect/network errors for API requests
                async failedRequestHandler({ request }, error) {
                                        const { slug, profileUrl, useApi } = request.userData;

                        // If the API path failed completely (e.g. MaxRedirectsError), try HTML
                        if (useApi) {
                                                        const enqueued = await enqueueHtmlFallback(slug, profileUrl,
                                                                                                                                   `API path failed: ${error.message}`);
                                                        if (enqueued) return; // Give HTML a chance before recording failure
                        }

                        errorCount++;
                                        log.error(`✗ Failed to scrape ${slug} after retries: ${error.message}`);
                                        await Actor.pushData(emptyResult(profileUrl, 'failed', { error: error.message }));
                },
});

// ── Run ──────────────────────────────────────────────────────────────────
await crawler.run(requests);

// ── Summary ──────────────────────────────────────────────────────────────
log.info('═══════════════════════════════════════');
log.info(`Scraping complete:`);
log.info(`  ✓ Success:    ${successCount}`);
log.info(`  ⚠ Login wall: ${loginWallCount}`);
log.info(`  ✗ Failed:     ${errorCount}`);
log.info(`  Total:        ${requests.length}`);
log.info('═══════════════════════════════════════');

await Actor.exit();
