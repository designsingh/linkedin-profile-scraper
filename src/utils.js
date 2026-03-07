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

    // Already a full URL
    if (/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(trimmed)) {
        // Ensure https and www
        const slug = trimmed.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '');
        return `https://www.linkedin.com/in/${slug}`;
    }

    // Missing protocol: linkedin.com/in/username
    if (/^(www\.)?linkedin\.com\/in\//i.test(trimmed)) {
        const slug = trimmed.replace(/^(www\.)?linkedin\.com\/in\//i, '');
        return `https://www.linkedin.com/in/${slug}`;
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
    const indicators = [
        'authwall',
        'login',
        'sign-in',
        'uas/login',
        'session_redirect',
        'checkpoint/challenge',
    ];
    const lower = html.substring(0, 5000).toLowerCase();
    return indicators.some((ind) => lower.includes(ind));
}
