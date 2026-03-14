/**
 * Normalize a LinkedIn profile URL or slug into a canonical URL.
 * Handles: full URLs, protocol-less URLs, bare slugs, invisible chars,
 * smart quotes, \r\n, zero-width spaces, query params, fragments.
 */
export function normalizeProfileUrl(input) {
    if (!input || typeof input !== 'string') return null;

    // Aggressive cleaning
    let cleaned = input
        .replace(/[\r\n\t]/g, '')              // line breaks & tabs
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width chars
        .replace(/[""'']/g, '')                // smart quotes
        .trim()
        .replace(/\/+$/, '');                  // trailing slashes

    // Add protocol if missing
    if (/^(www\.)?linkedin\.com/i.test(cleaned)) {
        cleaned = 'https://' + cleaned;
    }

    // Try URL parsing (handles query params, fragments, etc.)
    try {
        const url = new URL(cleaned);
        const pathMatch = url.pathname.match(/^\/in\/([^/]+)/i);
        if (pathMatch && url.hostname.match(/linkedin\.com$/i)) {
            return `https://www.linkedin.com/in/${pathMatch[1].toLowerCase()}`;
        }
    } catch {
        // Not a valid URL — fall through to bare slug check
    }

    // Bare slug: "preetarjun" or "/in/preetarjun"
    const bareSlug = cleaned
        .replace(/^\/?(in\/)?/i, '')
        .replace(/[/?#].*$/, '');

    if (bareSlug && /^[a-zA-Z0-9][\w-]{2,99}$/.test(bareSlug) && !bareSlug.includes(' ')) {
        return `https://www.linkedin.com/in/${bareSlug.toLowerCase()}`;
    }

    return null;
}

/**
 * Extract the username slug from a profile URL.
 */
export function extractSlug(url) {
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/in\/([^/]+)/i);
        return match ? match[1].toLowerCase() : null;
    } catch {
        const match = url.match(/\/in\/([^/?#]+)/i);
        return match ? match[1].toLowerCase() : null;
    }
}

/**
 * Random delay between min and max milliseconds.
 */
export function randomDelay(minMs = 1000, maxMs = 3000) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Detect if the response HTML is a login wall redirect.
 */
export function isLoginWall(html) {
    if (!html) return true;
    const lower = html.substring(0, 10000).toLowerCase();

    // Strong signals — the page title or URL-based redirects
    const strongIndicators = [
        '<title>linkedin: log in or sign up</title>',
        'authwall',
        'uas/login',
        'session_redirect',
        'checkpoint/challenge',
        'join now to see the full profile',
        'sign in to view this profile',
    ];
    if (strongIndicators.some((ind) => lower.includes(ind))) return true;

    // If <title> contains a person name + "LinkedIn", it's a real profile page
    if (/<title>[^<]*\|?\s*linkedin<\/title>/i.test(lower) && !lower.includes('log in or sign up')) {
        return false;
    }

    // Check for login form elements as a fallback
    const formIndicators = [
        'name="session_key"',
        'name="session_password"',
        'id="join-form"',
    ];
    return formIndicators.some((ind) => lower.includes(ind));
}
