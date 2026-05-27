/**
 * Gemini job search/discovery.
 *
 * Searches one job title at a time with short, focused queries so Gemini's
 * Google Search grounding actually fires. Results are merged and deduped.
 */

const { GeminiClient } = require("./client");

const DEFAULT_MAX_CANDIDATES = parseInt(process.env.HYBRID_SEARCH_MAX_RESULTS || "10", 10);

// Domains that should never appear in results
const BANNED_DOMAINS = /indeed\.com|linkedin\.com|ziprecruiter\.com|glassdoor\.com|simplyhired\.com|monster\.com/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split "Senior SWE, ML Engineer, Data Scientist" → ["Senior SWE", "ML Engineer", "Data Scientist"] */
function extractJobTitles(prefs) {
  return (prefs.jobTitle || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 4); // cap at 4 to control cost
}

/** Build a short, Gemini-friendly search query for one title. */
function buildSimpleQuery(title, prefs) {
  const parts = [title];
  if (prefs.remoteOnly)        parts.push("remote");
  else if (prefs.locationCity) parts.push(prefs.locationCity, prefs.locationRadius ? `within ${prefs.locationRadius}` : "");
  if (prefs.experienceLevel)   parts.push(prefs.experienceLevel);
  if (prefs.industries)        parts.push(prefs.industries.split(",")[0].trim()); // first industry only
  return parts.filter(Boolean).join(" ");
}

/** Location string for the criteria block in the prompt. */
function locationLabel(prefs) {
  if (prefs.remoteOnly)        return "Remote only";
  if (prefs.locationCity)      return `Within ${prefs.locationRadius || "any distance"} of ${prefs.locationCity}`;
  return prefs.location || "";
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSearchPrompt(title, simpleQuery, prefs, seenSection, staleUrlList) {
  const loc   = locationLabel(prefs);
  const stale = staleUrlList && staleUrlList.length > 0
    ? `\nKNOWN EXPIRED URLS — never return any of these:\n${staleUrlList.slice(0, 30).join("\n")}\n`
    : "";

  return `Search for real, current "${title}" job postings using Google Search.

REQUIRED:
- Role: ${title}
${loc           ? `- Location: ${loc}` : ""}
${prefs.experienceLevel ? `- Level: ${prefs.experienceLevel}` : ""}
${prefs.salaryMin       ? `- Min salary: ${prefs.salaryMin}` : ""}
${seenSection}
SEARCH THESE SOURCES IN ORDER (use Google Search for each):
1. site:hiring.cafe ${simpleQuery}
2. site:boards.greenhouse.io ${simpleQuery}
3. site:jobs.lever.co ${simpleQuery}
4. site:jobs.ashbyhq.com ${simpleQuery}
5. site:builtin.com ${simpleQuery}
6. site:wellfound.com ${simpleQuery}
${stale}
URL RULES — strict:
- Every URL must link directly to ONE specific job posting.
- Valid URL contains a unique job ID or slug, e.g.:
    boards.greenhouse.io/COMPANY/jobs/12345
    jobs.lever.co/COMPANY/some-uuid
    jobs.ashbyhq.com/COMPANY/job-slug
    hiring.cafe/jobs/12345
    company.com/careers/role-title-12345
- REJECT: company.com/careers/ or company.com/careers (no job ID = invalid)
- REJECT: any search results page or aggregator listing page
- REJECT: ziprecruiter.com, glassdoor.com, indeed.com, linkedin.com
- If you cannot find a direct URL with a job ID, omit that job entirely.
- Prefer postings from the last 14 days.

ATS DETECTION:
- boards.greenhouse.io/SLUG/jobs/ID → atsType="greenhouse", atsSlug="SLUG"
- jobs.lever.co/SLUG/UUID           → atsType="lever",      atsSlug="SLUG"
- jobs.ashbyhq.com/SLUG/...         → atsType="ashby",      atsSlug="SLUG"
- COMPANY.workday.com/...           → atsType="workday"

Return ONLY a raw JSON array — no markdown, no explanation. Up to 5 results:
[{
  "title": "",
  "company": "",
  "location": "",
  "salary": "",
  "experience": "Entry Level | Mid Level | Senior | Manager (infer from title/description — do NOT leave blank)",
  "description": "",
  "possibleJobUrl": "",
  "atsType": "",
  "atsSlug": "",
  "posted": "",
  "confidence": 0.9
}]

confidence: 1.0 = URL definitely links to this exact posting with a job ID.
0.7 = URL likely correct. Below 0.6 = omit the job entirely.
For experience: always infer from title/description — do NOT leave blank.
Return [] if no valid direct-link postings found.`;
}

function buildPass2Prompt(title, simpleQuery, prefs, alreadyFound, seenSection) {
  const loc = locationLabel(prefs);

  const foundSection = alreadyFound.length > 0
    ? `\nAlready found — skip:\n${alreadyFound.map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  return `Second search pass for "${title}" job postings. Use DIFFERENT sources.
Do NOT search hiring.cafe, greenhouse.io, or lever.co again.

REQUIRED:
- Role: ${title}
${loc           ? `- Location: ${loc}` : ""}
${prefs.experienceLevel ? `- Level: ${prefs.experienceLevel}` : ""}
${foundSection}${seenSection}
SEARCH THESE SOURCES:
1. site:linkedin.com/jobs ${simpleQuery}
2. site:indeed.com ${simpleQuery}
3. ${title} ${prefs.locationCity || ""} careers site

Same URL rules as before:
- Direct links with job IDs only. Reject careers homepages and search pages.
- Reject ziprecruiter.com, glassdoor.com aggregators.

Return ONLY a raw JSON array, up to 5 results. Same schema as before.
Return [] if no valid postings found.`;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseJobCandidates(rawText, source) {
  try {
    const clean = rawText.replace(/^```(?:json)?\s*/im, "").replace(/\s*```$/m, "").trim();
    const start = clean.indexOf("[");
    const end   = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(j => j && j.company && j.title)
      .map(j => {
        const url = (j.possibleJobUrl || j.url || "").trim();
        // Pre-filter: reject banned domains and bare careers pages
        if (!url || BANNED_DOMAINS.test(url))   return null;
        if (!hasJobId(url))                      return null;
        return {
          title:          (j.title       || "").trim(),
          company:        (j.company     || "").trim(),
          location:       (j.location    || "").trim(),
          salary:         (j.salary      || "").trim(),
          experience:     (j.experience  || "").trim(),
          description:    (j.description || "").trim(),
          possibleJobUrl: url,
          url,
          atsProvider:    (j.atsType || j.atsProvider || "").trim().toLowerCase(),
          atsSlug:        (j.atsSlug || "").trim(),
          posted:         (j.posted  || "").trim(),
          confidence:     typeof j.confidence === "number" ? j.confidence : 0.5,
          source:         source || "gemini",
          geminiDiscovered: true,
          urlVerified:    false,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[GeminiSearch] JSON parse failed (${source}): ${err.message}`);
    return [];
  }
}

/**
 * True if the URL looks like a direct job posting (has a job ID/slug).
 * Rejects bare /careers/ pages and aggregator search results.
 */
function hasJobId(url) {
  try {
    const u    = new URL(url);
    const path = u.pathname;

    // Known ATS patterns — always valid
    if (/^\/[\w-]+\/jobs\/\d+/.test(path))          return true; // greenhouse
    if (/^\/[\w-]+\/[0-9a-f-]{20,}/.test(path))     return true; // lever UUID
    if (/\/jobs?\/[\w-]{4,}/.test(path))             return true; // generic /jobs/slug
    if (/\/\d{5,}/.test(path))                       return true; // numeric job ID
    if (/\/[0-9a-f-]{20,}/.test(path))               return true; // UUID anywhere in path
    if (/\/careers\/[\w-]{8,}/.test(path))           return true; // /careers/role-slug-id

    // Search results pages — always invalid
    if (u.search.includes("search="))                return false;
    if (u.search.includes("q="))                     return false;

    return false;
  } catch {
    return false;
  }
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Discover job candidates using Gemini's grounded search.
 * Searches each job title separately for reliable grounding results.
 */
async function discoverJobs(params) {
  const { query, prefs, tier, geminiClient, userId, staleUrls = [], recentJobs = [], logFn } = params;
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  const titles = extractJobTitles(prefs);
  if (titles.length === 0) {
    log("[GeminiSearch] No job titles extracted from prefs");
    return [];
  }

  const seenSection = recentJobs.length > 0
    ? `\nAlready found this week — skip:\n${recentJobs.slice(0, 15).map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  log(`[GeminiSearch] Pass 1: Searching ${titles.length} title(s) with Gemini + Google Search…`);

  const allCandidates = [];
  const seenKeys      = new Set();

  // Search each title independently — parallel for 2+ titles, capped at 4
  const searchPromises = titles.map(async (title) => {
    const simpleQuery = buildSimpleQuery(title, prefs);
    const prompt      = buildSearchPrompt(title, simpleQuery, prefs, seenSection, staleUrls);

    log(`[GeminiSearch] Searching: "${simpleQuery}"…`);
    try {
      const result = await geminiClient.generate({
        modelId:  geminiClient.searchModel,
        prompt,
        tools:    [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0 } } }],
        userId,
        view:     "gemini_search_pass1",
      });
      log(`[GeminiSearch] "${title}" → ${result.text.length} chars, ${result.usage.groundingChunks} grounding chunks`);
      return parseJobCandidates(result.text, `gemini_pass1_${title}`);
    } catch (err) {
      log(`[GeminiSearch] "${title}" search failed: ${err.message}`);
      return [];
    }
  });

  const results = await Promise.all(searchPromises);
  for (const batch of results) {
    for (const job of batch) {
      const key = `${job.title.toLowerCase()}__${job.company.toLowerCase()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allCandidates.push(job);
      }
    }
  }

  log(`[GeminiSearch] Pass 1 total: ${allCandidates.length} candidates across ${titles.length} title(s)`);
  return allCandidates;
}

/**
 * Second discovery pass — different sources (LinkedIn, Indeed, careers pages).
 */
async function discoverJobsPass2(params) {
  const { prefs, geminiClient, userId, alreadyFound = [], recentJobs = [], logFn } = params;
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  const titles = extractJobTitles(prefs);
  const seenSection = recentJobs.length > 0
    ? `\nAlready found this week — skip:\n${recentJobs.slice(0, 15).map(j => `- ${j.company}: ${j.title}`).join("\n")}\n`
    : "";

  log(`[GeminiSearch] Pass 2: Searching ${titles.length} title(s) via alternative sources…`);

  const allCandidates = [];
  const seenKeys      = new Set(alreadyFound.map(j => `${(j.title||"").toLowerCase()}__${(j.company||"").toLowerCase()}`));

  const searchPromises = titles.map(async (title) => {
    const simpleQuery = buildSimpleQuery(title, prefs);
    const prompt      = buildPass2Prompt(title, simpleQuery, prefs, alreadyFound, seenSection);

    try {
      const result = await geminiClient.generate({
        modelId:  geminiClient.searchModel,
        prompt,
        tools:    [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0 } } }],
        userId,
        view:     "gemini_search_pass2",
      });
      return parseJobCandidates(result.text, `gemini_pass2_${title}`);
    } catch (err) {
      log(`[GeminiSearch] Pass 2 "${title}" failed: ${err.message}`);
      return [];
    }
  });

  const results = await Promise.all(searchPromises);
  for (const batch of results) {
    for (const job of batch) {
      const key = `${job.title.toLowerCase()}__${job.company.toLowerCase()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allCandidates.push(job);
      }
    }
  }

  log(`[GeminiSearch] Pass 2 total: ${allCandidates.length} new candidates`);
  return allCandidates;
}

module.exports = { discoverJobs, discoverJobsPass2, hasJobId };
