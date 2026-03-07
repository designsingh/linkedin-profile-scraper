/**
 * Normalize a LinkedIn profile URL or slug into a canonical URL.
 * Accepts:
 *   - https://www.linkedin.com/in/username
 *   - https://linkedin.com/in/username/
 *   - linkedin.com/in/username
 *   - username (bare slug)
 */
export function normalizeProfileUrl(input) {
    let trimmed = input.trim().replace(/\/+$/, '');

    // Handle country-specific subdomains (ca.linkedin.com, uk.linkedin.com, etc.)
    // and mobile URLs (mwlite)
    if (/^https?:\/\/([a-z]{2}\.)?linkedin\.com\/(mwlite\/)?in\//i.test(trimmed)) {
        const slug = trimmed.replace(/^https?:\/\/([a-z]{2}\.)?(www\.)?linkedin\.com\/(mwlite\/)?in\//i, '');
        return `https://www.linkedin.com/in/${slug}`;
    }

    // Missing protocol but has linkedin.com domain (including Www, www, etc.)
    if (/^(www\.|Www\.)?linkedin\.com\/(mwlite\/)?in\//i.test(trimmed)) {
        const slug = trimmed.replace(/^(www\.|Www\.)?linkedin\.com\/(mwlite\/)?in\//i, '');
        return `https://www.linkedin.com/in/${slug}`;
    }

    // Just the /in/username path (no domain)
    if (/^\/in\//i.test(trimmed)) {
        const slug = trimmed.replace(/^\/in\//i, '');
        if (slug && !slug.includes(' ')) return `https://www.linkedin.com/in/${slug}`;
    }

    // Bare slug
    const slug = trimmed.replace(/^\/+/, '');
    if (slug && !slug.includes('/') && !slug.includes(' ')) {
        return `https://www.linkedin.com/in/${slug}`;
    }

    return null; // Invalid input
}

/**
 * Extract the username slug from a profile URL.
 */
export function extractSlug(url) {
    const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
    return match ? match[1] : null;
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
