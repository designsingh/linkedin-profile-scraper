import * as cheerio from 'cheerio';

/**
 * Parse a public LinkedIn profile page.
 * Strategy:
 *   1. JSON-LD <script type="application/ld+json"> — best structured data
 *   2. OG meta tags — name, description, image
 *   3. Visible HTML — experience sections, education, skills, about
 */
export function parseProfile(html, profileUrl, options = {}) {
    const $ = cheerio.load(html);
    const { includeExperience = true, includeEducation = true, includeSkills = false } = options;

    // ── 1. JSON-LD extraction ──────────────────────────────────────────
    const jsonLd = extractJsonLd($);
    const person = jsonLd || {};

    // ── 2. OG meta fallbacks ───────────────────────────────────────────
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const metaDesc = $('meta[name="description"]').attr('content') || '';

    // ── 3. Derive core fields ──────────────────────────────────────────
    const fullName = person.name
        || ogTitle.split(' - ')[0]?.split('|')[0]?.trim()
        || $('title').text().split(' - ')[0]?.split('|')[0]?.trim()
        || '';

    // LinkedIn masks job titles with asterisks for non-logged-in users in JSON-LD.
    // If masked, skip and fall back to OG tags or visible HTML.
    const rawJobTitle = person.jobTitle?.[0] || '';
    const isMasked = rawJobTitle && /^\*[\s*]+$/.test(rawJobTitle.replace(/[^*\s]/g, ''));
    const headline = (!isMasked && rawJobTitle)
        || extractHeadlineFromOg(ogTitle)
        || $('h2.top-card-layout__headline').text().trim()
        || '';

    const location = person.address?.addressLocality
        || extractLocationFromDesc(ogDesc, metaDesc)
        || $('span.top-card__subline-item').first().text().trim()
        || $('div.top-card--list-bullet span').first().text().trim()
        || '';

    const about = extractAbout($)
        || extractAboutFromDesc(ogDesc, metaDesc)
        || '';

    const profileImageUrl = person.image?.contentUrl
        || ogImage
        || $('img.top-card__profile-image, img.top-card-layout__entity-image').attr('src')
        || '';

    // ── 4. Current title + company (primary fields for DesignX) ────────
    const { currentTitle, currentCompany, currentCompanyUrl } = extractCurrentRole(person, $);

    // ── 5. Experience ──────────────────────────────────────────────────
    let experience = [];
    let experienceCount = 0;
    if (includeExperience) {
        experience = extractExperience(person, $);
        experienceCount = experience.length;
    }

    // ── 6. Education ───────────────────────────────────────────────────
    let education = [];
    let educationCount = 0;
    if (includeEducation) {
        education = extractEducation(person, $);
        educationCount = education.length;
    }

    // ── 7. Skills ──────────────────────────────────────────────────────
    let skills = [];
    if (includeSkills) {
        skills = extractSkills($);
    }

    // ── 8. Follower / connection counts ────────────────────────────────
    const { followerCount, connectionCount } = extractCounts($, ogDesc, metaDesc);

    // ── 9. Data quality indicator ──────────────────────────────────────
    const dataQuality = jsonLd ? 'full' : (fullName ? 'partial' : 'minimal');

    return {
        profileUrl,
        fullName,
        headline,
        currentTitle,
        currentCompany,
        currentCompanyUrl,
        location,
        about: cleanAbout(about),
        profileImageUrl,
        experience: includeExperience ? experience : undefined,
        experienceCount,
        education: includeEducation ? education : undefined,
        educationCount,
        skills: includeSkills ? skills : undefined,
        followerCount,
        connectionCount,
        dataQuality,
        loginWallDetected: false,
        scrapedAt: new Date().toISOString(),
    };
}


// ═══════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Clean the about text by removing login wall HTML that LinkedIn injects
 * partway through the public profile page.
 */
function cleanAbout(raw) {
    if (!raw) return '';
    // Cut at common login wall markers
    const markers = [
        'Welcome back',
        'Email or phone',
        'Sign in',
        'see more',
        'Join now',
        'New to LinkedIn?',
        'By clicking Continue',
    ];
    let cleaned = raw;
    for (const marker of markers) {
        const idx = cleaned.indexOf(marker);
        if (idx > 0) {
            cleaned = cleaned.substring(0, idx);
        }
    }
    // Remove excess whitespace from stripped HTML
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Cap length
    return cleaned.substring(0, 2000);
}

function extractJsonLd($) {
    let person = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html());

            // Could be a single object or have @graph array
            if (data['@graph']) {
                const p = data['@graph'].find((item) => item['@type'] === 'Person');
                if (p) person = p;
            } else if (data['@type'] === 'Person') {
                person = data;
            }
        } catch {
            // Invalid JSON, skip
        }
    });
    return person;
}

function extractHeadlineFromOg(ogTitle) {
    // OG title format: "Name - Title - Company | LinkedIn"
    // When masked: "Name - Company | LinkedIn" (only 2 parts — no title to extract)
    const parts = ogTitle.split(' - ');
    if (parts.length >= 3) {
        // Has title: return middle parts (everything between name and "Company | LinkedIn")
        return parts.slice(1, -1).join(' - ').trim();
    }
    // Only 2 parts = name + company, no title available
    if (parts.length === 2) {
        return '';
    }
    return '';
}

function extractLocationFromDesc(ogDesc, metaDesc) {
    const desc = ogDesc || metaDesc || '';
    // Common patterns: "Location · 500+ connections" or "Location. Experience:"
    const locMatch = desc.match(/^([^·.]+?)(?:\s*·|\.\s)/);
    if (locMatch && locMatch[1].length < 80) {
        return locMatch[1].trim();
    }
    return '';
}

function extractAbout($) {
    // Public profile about section
    const aboutSection = $('section.summary, section[data-section="summary"]');
    if (aboutSection.length) {
        return aboutSection.find('p, div.core-section-container__content').text().trim();
    }

    // Alternative selectors for different page layouts
    const aboutDiv = $('div.core-section-container--with-content-padding').first();
    if (aboutDiv.length) {
        const text = aboutDiv.find('p').first().text().trim();
        if (text.length > 20) return text;
    }

    return '';
}

function extractAboutFromDesc(ogDesc, metaDesc) {
    const desc = ogDesc || metaDesc || '';
    // Strip the leading location + connections part
    const stripped = desc
        .replace(/^[^·]+·\s*/, '')
        .replace(/^\d+\+?\s*(connections?|followers?)\s*·?\s*/i, '')
        .trim();
    return stripped.length > 20 ? stripped : '';
}

function extractCurrentRole(person, $) {
    let currentTitle = '';
    let currentCompany = '';
    let currentCompanyUrl = '';

    // From JSON-LD (skip if masked with asterisks)
    if (person.jobTitle) {
        const titles = Array.isArray(person.jobTitle) ? person.jobTitle : [person.jobTitle];
        const raw = titles[0] || '';
        if (raw && !/^\*[\s*]+$/.test(raw.replace(/[^*\s]/g, ''))) {
            currentTitle = raw;
        }
    }

    if (person.worksFor) {
        const orgs = Array.isArray(person.worksFor) ? person.worksFor : [person.worksFor];
        const current = orgs[0];
        if (current) {
            currentCompany = current.name || '';
            currentCompanyUrl = current.url || current.sameAs || '';
        }
    }

    // If title is still empty, try to extract from OG title ("Name - Title - Company | LinkedIn")
    if (!currentTitle) {
        const ogTitle = $('meta[property="og:title"]').attr('content') || '';
        const fromOg = extractHeadlineFromOg(ogTitle);
        if (fromOg) currentTitle = fromOg;
    }

    // HTML fallback
    if (!currentTitle || !currentCompany) {
        const expItem = $('li.experience-item, li.profile-section-card').first();
        if (!currentTitle) {
            const htmlTitle = expItem.find('h3, span.experience-item__title').text().trim();
            // Don't use it if it's the same as the company (masked profiles show company in h3)
            if (htmlTitle && htmlTitle.toLowerCase() !== currentCompany.toLowerCase()) {
                currentTitle = htmlTitle;
            }
        }
        if (!currentCompany) {
            currentCompany = expItem.find('h4, span.experience-item__subtitle').text().trim() || currentCompany;
        }
    }

    return { currentTitle, currentCompany, currentCompanyUrl };
}

function extractExperience(person, $) {
    const experiences = [];

    // From JSON-LD memberOf or worksFor (limited but structured)
    if (person.worksFor) {
        const orgs = Array.isArray(person.worksFor) ? person.worksFor : [person.worksFor];
        orgs.forEach((org) => {
            experiences.push({
                title: '',
                company: org.name || '',
                companyUrl: org.url || org.sameAs || '',
                location: '',
                startDate: '',
                endDate: '',
                isCurrent: true,
            });
        });
    }

    // From HTML — experience list items
    const expItems = $('li.experience-item, ul.experience__list > li, section#experience ~ ul > li');
    expItems.each((i, el) => {
        const title = $(el).find('h3, span.experience-item__title, div.experience-item__title').text().trim();
        const company = $(el).find('h4, span.experience-item__subtitle, a.experience-item__subtitle').text().trim();
        const dateRange = $(el).find('span.date-range, span.experience-item__duration').text().trim();
        const location = $(el).find('span.experience-item__location').text().trim();

        if (title || company) {
            const { startDate, endDate, isCurrent } = parseDateRange(dateRange);
            // Avoid duplicates from JSON-LD
            const isDupe = experiences.some(
                (e) => e.company && company && e.company.toLowerCase() === company.toLowerCase() && !e.title
            );
            if (isDupe) {
                const existing = experiences.find(
                    (e) => e.company.toLowerCase() === company.toLowerCase()
                );
                if (existing) {
                    existing.title = existing.title || title;
                    existing.location = existing.location || location;
                    existing.startDate = existing.startDate || startDate;
                    existing.endDate = existing.endDate || endDate;
                }
            } else {
                experiences.push({ title, company, companyUrl: '', location, startDate, endDate, isCurrent });
            }
        }
    });

    return experiences;
}

function extractEducation(person, $) {
    const education = [];

    // From JSON-LD
    if (person.alumniOf) {
        const schools = Array.isArray(person.alumniOf) ? person.alumniOf : [person.alumniOf];
        schools.forEach((school) => {
            education.push({
                school: school.name || '',
                degree: '',
                fieldOfStudy: '',
                startDate: '',
                endDate: '',
            });
        });
    }

    // From HTML
    const eduItems = $('li.education__list-item, ul.education__list > li, section#education ~ ul > li');
    eduItems.each((_, el) => {
        const school = $(el).find('h3, a.education-item__school-name').text().trim();
        const degree = $(el).find('span.education-item__degree-info, h4').text().trim();
        const dateRange = $(el).find('span.date-range, span.education-item__duration').text().trim();

        if (school) {
            const isDupe = education.some(
                (e) => e.school && school && e.school.toLowerCase() === school.toLowerCase()
            );
            if (isDupe) {
                const existing = education.find((e) => e.school.toLowerCase() === school.toLowerCase());
                if (existing) {
                    existing.degree = existing.degree || degree;
                }
            } else {
                const { startDate, endDate } = parseDateRange(dateRange);
                education.push({ school, degree, fieldOfStudy: '', startDate, endDate });
            }
        }
    });

    return education;
}

function extractSkills($) {
    const skills = [];
    const skillItems = $(
        'li.skill-categories__list-item, span.skill-categories__skill-name, ' +
        'section.skills ~ ul li, ol.skills__list li'
    );
    skillItems.each((_, el) => {
        const name = $(el).text().trim();
        if (name && name.length < 100 && !skills.includes(name)) {
            skills.push(name);
        }
    });
    return skills;
}

function extractCounts($, ogDesc, metaDesc) {
    let followerCount = '';
    let connectionCount = '';

    const desc = ogDesc || metaDesc || '';

    // "500+ connections" or "1K followers"
    const connMatch = desc.match(/([\d,]+\+?)\s*connections?/i);
    if (connMatch) connectionCount = connMatch[1];

    const follMatch = desc.match(/([\d,]+[KkMm]?\+?)\s*followers?/i);
    if (follMatch) followerCount = follMatch[1];

    // HTML fallback
    if (!followerCount) {
        const follEl = $('span.top-card__subline-item--followers, dd.text-body-small').first();
        const follText = follEl.text().trim();
        const m = follText.match(/([\d,]+[KkMm]?\+?)\s*followers?/i);
        if (m) followerCount = m[1];
    }

    if (!connectionCount) {
        const connEl = $('span.top-card__subline-item--connections').first();
        const connText = connEl.text().trim();
        const m = connText.match(/([\d,]+\+?)\s*connections?/i);
        if (m) connectionCount = m[1];
    }

    return { followerCount, connectionCount };
}

function parseDateRange(dateRange) {
    if (!dateRange) return { startDate: '', endDate: '', isCurrent: false };

    const isCurrent = /present/i.test(dateRange);
    const parts = dateRange.split('–').map((s) => s.trim());
    // Also try en-dash and hyphen
    const parts2 = dateRange.split('-').map((s) => s.trim());
    const useParts = parts.length >= 2 ? parts : parts2;

    return {
        startDate: useParts[0] || '',
        endDate: isCurrent ? 'Present' : (useParts[1] || ''),
        isCurrent,
    };
}


// ═══════════════════════════════════════════════════════════════════════
// Voyager API parser (authenticated responses)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse a LinkedIn Voyager API profile response.
 * The API returns normalized JSON with an `included` array containing
 * all entities (profile, positions, education, skills, etc.)
 */
export function parseVoyagerProfile(data, profileUrl, options = {}) {
    const { includeExperience = true, includeEducation = true, includeSkills = false } = options;

    // The Voyager API response has different shapes depending on the endpoint.
    // Common patterns:
    //   { data: { ... }, included: [ ... ] }
    //   { elements: [ ... ], ... }
    //   Direct profile object with miniProfile, etc.

    // Find the main profile data
    // Dash API returns { data: {}, included: [] } or { elements: [{}], included: [] }
    const included = data.included || [];
    let profileData = data.data || data;

    // Dash API wraps in elements array
    if (data.elements && Array.isArray(data.elements) && data.elements.length > 0) {
        profileData = data.elements[0];
    }

    // Also search included for the main profile entity
    const profileEntity = included.find(item =>
        (item.$type?.includes('Profile') || item.$type?.includes('MiniProfile'))
        && item.firstName && item.lastName
    );
    if (profileEntity && !profileData.firstName) {
        profileData = { ...profileEntity, ...profileData };
    }

    // Extract from the main profile object
    const fullName = profileData.firstName && profileData.lastName
        ? `${profileData.firstName} ${profileData.lastName}`
        : findInIncluded(included, 'firstName', 'lastName');

    const headline = profileData.headline
        || findFieldInIncluded(included, 'headline')
        || '';

    const location = profileData.locationName
        || profileData.geoLocationName
        || findFieldInIncluded(included, 'locationName')
        || findFieldInIncluded(included, 'geoLocationName')
        || '';

    const about = profileData.summary
        || findFieldInIncluded(included, 'summary')
        || '';

    const industryName = profileData.industryName
        || findFieldInIncluded(included, 'industryName')
        || '';

    // Profile image
    const profileImageUrl = extractVoyagerImage(profileData)
        || extractVoyagerImageFromIncluded(included)
        || '';

    // Current role from headline or positions
    const { currentTitle, currentCompany, currentCompanyUrl } = extractVoyagerCurrentRole(
        profileData, included, headline
    );

    // Experience
    let experience = [];
    let experienceCount = 0;
    if (includeExperience) {
        experience = extractVoyagerExperience(included);
        experienceCount = experience.length;
    }

    // Education
    let education = [];
    let educationCount = 0;
    if (includeEducation) {
        education = extractVoyagerEducation(included);
        educationCount = education.length;
    }

    // Skills
    let skills = [];
    if (includeSkills) {
        skills = extractVoyagerSkills(included);
    }

    const dataQuality = fullName ? 'full' : 'minimal';

    return {
        profileUrl,
        fullName,
        headline,
        currentTitle,
        currentCompany,
        currentCompanyUrl,
        location,
        about: about.substring(0, 2000),
        profileImageUrl,
        industryName,
        experience: includeExperience ? experience : undefined,
        experienceCount,
        education: includeEducation ? education : undefined,
        educationCount,
        skills: includeSkills ? skills : undefined,
        followerCount: '',
        connectionCount: '',
        dataQuality,
        loginWallDetected: false,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Parse embedded Voyager JSON data from LinkedIn's authenticated SPA HTML.
 * LinkedIn embeds profile data in <code> elements as JSON wrapped in HTML comments.
 */
export function parseEmbeddedVoyagerData(html, profileUrl, options = {}) {
    try {
        const $ = cheerio.load(html);
        const allIncluded = [];

        // LinkedIn embeds data in <code> tags: <!--{"data":...}-->
        $('code').each((_, el) => {
            const raw = $(el).html();
            if (!raw) return;

            // Strip HTML comment markers
            const jsonStr = raw.replace(/^<!--/, '').replace(/-->$/, '').trim();
            if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) return;

            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.included && Array.isArray(parsed.included)) {
                    allIncluded.push(...parsed.included);
                }
                if (parsed.data?.included && Array.isArray(parsed.data.included)) {
                    allIncluded.push(...parsed.data.included);
                }
            } catch {
                // Not valid JSON, skip
            }
        });

        if (allIncluded.length === 0) return null;

        // Build a synthetic Voyager response and use the existing parser
        return parseVoyagerProfile({ included: allIncluded }, profileUrl, options);
    } catch {
        return null;
    }
}

function findInIncluded(included, firstNameField, lastNameField) {
    for (const item of included) {
        if (item[firstNameField] && item[lastNameField]) {
            return `${item[firstNameField]} ${item[lastNameField]}`;
        }
    }
    return '';
}

function findFieldInIncluded(included, field) {
    for (const item of included) {
        if (item[field] && typeof item[field] === 'string') {
            return item[field];
        }
    }
    return '';
}

function extractVoyagerImage(profileData) {
    // Profile images are in displayPictureUrl or profilePicture
    const pic = profileData.profilePicture || profileData.displayPictureUrl;
    if (typeof pic === 'string') return pic;
    if (pic?.displayImage) {
        // It's a reference like "urn:li:digitalmediaAsset:..."
        // The actual URLs are in the included array
        return '';
    }
    // Try displayPictureUrl + img_XXX format
    const base = profileData.displayPictureUrl;
    const suffix = profileData.img_800_800 || profileData.img_400_400 || profileData.img_200_200;
    if (base && suffix) return base + suffix;
    return '';
}

function extractVoyagerImageFromIncluded(included) {
    for (const item of included) {
        // Look for vectorImage or displayImageReference
        if (item.$type?.includes('Photo') || item.$type?.includes('Image')) {
            const artifacts = item.displayImageReference?.vectorImage?.artifacts
                || item.vectorImage?.artifacts
                || [];
            if (artifacts.length > 0) {
                const largest = artifacts[artifacts.length - 1];
                const root = item.displayImageReference?.vectorImage?.rootUrl
                    || item.vectorImage?.rootUrl || '';
                return root + (largest.fileIdentifyingUrlPathSegment || '');
            }
        }
        // Simple displayPictureUrl
        if (item.displayPictureUrl && item.img_400_400) {
            return item.displayPictureUrl + item.img_400_400;
        }
    }
    return '';
}

function extractVoyagerCurrentRole(profileData, included, headline) {
    let currentTitle = '';
    let currentCompany = '';
    let currentCompanyUrl = '';

    // Try to get from positions in included array
    const positions = included.filter(item =>
        item.$type?.includes('Position') ||
        item.$type?.includes('position')
    );

    // Find current position (no end date or timePeriod.endDate)
    const currentPos = positions.find(p => {
        if (p.timePeriod && !p.timePeriod.endDate) return true;
        if (p.dateRange && !p.dateRange.end) return true;
        return false;
    }) || positions[0]; // fallback to first position

    if (currentPos) {
        currentTitle = currentPos.title || '';
        currentCompany = currentPos.companyName || '';
        currentCompanyUrl = currentPos.companyUrn || '';

        // If company name is missing, look it up in included
        if (!currentCompany && currentPos.company) {
            const companyRef = currentPos.company['*miniCompany'] || currentPos.company;
            if (typeof companyRef === 'string') {
                const companyEntity = included.find(i => i.entityUrn === companyRef);
                if (companyEntity) {
                    currentCompany = companyEntity.name || '';
                }
            }
        }
    }

    // Fallback: parse headline "Title at Company"
    if (!currentTitle && headline) {
        const atMatch = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
        if (atMatch) {
            currentTitle = atMatch[1].trim();
            if (!currentCompany) currentCompany = atMatch[2].trim();
        } else {
            // Headline might just be the title
            currentTitle = headline;
        }
    }

    return { currentTitle, currentCompany, currentCompanyUrl };
}

function extractVoyagerExperience(included) {
    const experiences = [];

    const positions = included.filter(item =>
        item.$type?.includes('Position') ||
        item.$type?.includes('position')
    );

    for (const pos of positions) {
        const startDate = pos.timePeriod?.startDate
            ? formatVoyagerDate(pos.timePeriod.startDate)
            : (pos.dateRange?.start ? formatVoyagerDate(pos.dateRange.start) : '');
        const endDate = pos.timePeriod?.endDate
            ? formatVoyagerDate(pos.timePeriod.endDate)
            : (pos.dateRange?.end ? formatVoyagerDate(pos.dateRange.end) : '');
        const isCurrent = !pos.timePeriod?.endDate && !pos.dateRange?.end;

        experiences.push({
            title: pos.title || '',
            company: pos.companyName || '',
            companyUrl: pos.companyUrn || '',
            location: pos.locationName || pos.geoLocationName || '',
            startDate,
            endDate: isCurrent ? 'Present' : endDate,
            isCurrent,
        });
    }

    return experiences;
}

function extractVoyagerEducation(included) {
    const education = [];

    const schools = included.filter(item =>
        item.$type?.includes('Education') ||
        item.$type?.includes('education')
    );

    for (const edu of schools) {
        const startDate = edu.timePeriod?.startDate
            ? formatVoyagerDate(edu.timePeriod.startDate)
            : '';
        const endDate = edu.timePeriod?.endDate
            ? formatVoyagerDate(edu.timePeriod.endDate)
            : '';

        education.push({
            school: edu.schoolName || edu.school || '',
            degree: edu.degreeName || edu.degree || '',
            fieldOfStudy: edu.fieldOfStudy || '',
            startDate,
            endDate,
        });
    }

    return education;
}

function extractVoyagerSkills(included) {
    const skills = [];

    const skillEntities = included.filter(item =>
        item.$type?.includes('Skill') ||
        item.$type?.includes('skill')
    );

    for (const skill of skillEntities) {
        const name = skill.name || skill.skill?.name || '';
        if (name && !skills.includes(name)) {
            skills.push(name);
        }
    }

    return skills;
}

function formatVoyagerDate(dateObj) {
    if (!dateObj) return '';
    const { year, month } = dateObj;
    if (year && month) {
        return `${year}-${String(month).padStart(2, '0')}`;
    }
    if (year) return String(year);
    return '';
}
