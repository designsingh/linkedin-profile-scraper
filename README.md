# LinkedIn Profile Scraper — No Cookies 🍪

Scrape public LinkedIn profile data **without login or cookies**. Extract names, headlines, current titles, companies, locations, education, skills, and more from any public LinkedIn profile.

Built with [CheerioCrawler](https://crawlee.dev/) (no browser overhead). Pay per result.

## What it extracts

| Field | Source | Always available? |
|-------|--------|-------------------|
| Full name | JSON-LD / OG / HTML | ✅ |
| Headline | JSON-LD / OG | ✅ |
| **Current title** | JSON-LD / HTML | ✅ |
| **Current company** | JSON-LD / HTML | ✅ |
| Location | JSON-LD / OG / HTML | ✅ |
| About / bio | HTML / OG description | Usually |
| Profile image | JSON-LD / OG | ✅ |
| Work experience | JSON-LD + HTML | Optional |
| Education | JSON-LD + HTML | Optional |
| Skills | HTML | Optional |
| Follower count | OG / HTML | Sometimes |
| Connection count | OG / HTML | Sometimes |
| Data quality flag | — | ✅ |

## Input

Paste LinkedIn profile URLs (one per line). Accepts:
- `https://www.linkedin.com/in/satyanadella`
- `https://linkedin.com/in/satyanadella/`
- `linkedin.com/in/satyanadella`
- `satyanadella` (bare slug)

### Options

- **Include Experience** — full work history (default: on)
- **Include Education** — education list (default: on)
- **Include Skills** — skills list (default: off)
- **Slow Mode** — add random delays for 50+ profiles (default: off)
- **Max Concurrency** — parallel requests, 1–20 (default: 5)
- **Proxy** — residential proxies strongly recommended

## How it works

1. Normalizes and deduplicates input URLs
2. Fetches each public profile page via CheerioCrawler with proxy rotation
3. Extracts structured data from `<script type="application/ld+json">` (JSON-LD Person object)
4. Supplements with OG meta tags and visible HTML parsing
5. Detects login walls and flags blocked profiles

No headless browser. No cookies. No account risk.

## Data quality flags

- `full` — JSON-LD Person data found (best quality)
- `partial` — Name found but no JSON-LD (OG/HTML only)
- `minimal` — Very limited data extracted
- `blocked` — Login wall detected
- `failed` — Request failed after retries

## Pricing

Pay per result: **$2.00 / 1,000 profiles**

No charge for blocked or failed requests.

## Limitations

- LinkedIn may change their public page structure at any time. The scraper uses JSON-LD → OG meta → HTML fallback strategies.
- Some profiles are fully private and return no public data.
- Skills data is limited on public pages (usually top 3–5 only).
- Residential proxies significantly improve reliability.
- Rate limiting is common at scale. Use Slow Mode for 50+ profiles.

## Deploy

### 1. Push to GitHub

```bash
# Create a new repo on GitHub (github.com → New repository), then:
git remote add origin https://github.com/YOUR_USERNAME/linkedin-profile-scraper.git
git branch -M main
git push -u origin main
```

Or with SSH: `git@github.com:YOUR_USERNAME/linkedin-profile-scraper.git`

### 2. Apify Console → Link Git repo → Build

1. Go to [Apify Console](https://console.apify.com/) → **Actors** → **Create new** → **Import from Git repository**.
2. Paste your repo URL (e.g. `https://github.com/YOUR_USERNAME/linkedin-profile-scraper`) and connect (GitHub OAuth if needed).
3. Apify will detect `.actor/actor.json` and use it. Click **Build** to build the Docker image.
4. (Optional) Set **Pay per result** pricing at $2/1,000 profiles, then **Publish** to the Apify Store.

## Disclaimer

This Actor is an independent tool and is not affiliated with, endorsed by, or sponsored by LinkedIn Corporation. LinkedIn® is a registered trademark of LinkedIn Corporation. All trademarks are property of their respective owners. Please use this tool responsibly and in accordance with applicable laws and regulations.
