/**
 * Gemini URL verification.
 *
 * Two-stage approach:
 *  1. Pre-flight check (no API call) — instantly reject obvious non-job URLs.
 *  2. Gemini verification — confirm title/company match and staleness for URLs
 *     that pass pre-flight.
 */

const { hasJobId } = require("./search");

const URL_CONFIDENCE_THRESHOLD = parseFloat(process.env.GEMINI_URL_CONFIDENCE_MIN || "0.6");
const VERIFY_CONCURRENCY       = 3;

// ── HTTP liveness check ───────────────────────────────────────────────────────

/**
 * Quick HEAD/GET to confirm a URL isn't a 404/410.
 * Returns { ok: true } if the server responds with a non-4xx status.
 * Network errors are treated as unknown (not failed) to avoid over-rejection.
 */
async function httpLivenessCheck(url) {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; CareerCopilot/1.0; +https://careercopilot.app)" };
  const timeout = 6000;
  try {
    let res = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
    // Some servers return 405 on HEAD — fall through to GET
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
    }
    // 403 after GET = bot protection, not a dead posting — treat as unknown
    if (res.status === 403) return { ok: true, status: 403 };
    const ok = res.status < 400;
    return { ok, status: res.status };
  } catch {
    // Network error / timeout — treat as unknown, don't reject
    return { ok: true, status: 0 };
  }
}

// Domains that are never valid direct job links
const BANNED_DOMAINS = /ziprecruiter\.com|glassdoor\.com|simplyhired\.com|monster\.com/i;

// Job listing aggregators — have job IDs but are NOT direct employer apply links.
// Jobs from these domains should go through URL discovery to find the real link.
const AGGREGATOR_DOMAINS = /\bvaia\.com\b|\btalentsbyvaia\.com\b|\btealhq\.com\b|\blensa\.com\b|\bfactoryfix\.com\b|\bbuiltinla\.com\b|\bbuiltinsf\.com\b/i;

// ── Pre-flight check ──────────────────────────────────────────────────────────

/**
 * Fast pre-flight check — no API call required.
 * Returns { skip: true, result } if the URL can be immediately accepted or rejected.
 * Returns { skip: false } if Gemini verification is needed.
 */
function preflightCheck(url, expectedTitle, expectedCompany) {
  if (!url || !url.startsWith("http")) {
    return { skip: true, result: _failResult("No valid URL") };
  }

  // Banned aggregator domains
  if (BANNED_DOMAINS.test(url)) {
    return { skip: true, result: _failResult(`Banned aggregator domain: ${url}`) };
  }

  // Known listing aggregators — not a direct apply link, needs URL discovery
  if (AGGREGATOR_DOMAINS.test(url)) {
    return { skip: true, result: { ..._failResult("Aggregator domain — needs URL discovery for direct link"), needsDiscovery: true } };
  }

  let parsed;
  try { parsed = new URL(url); } catch {
    return { skip: true, result: _failResult("Unparseable URL") };
  }

  // Reject search results pages
  if (parsed.search.includes("search=") || parsed.search.includes("q=") || parsed.search.includes("query=")) {
    return { skip: true, result: _failResult("URL is a search results page") };
  }

  // Reject bare careers pages (e.g. /careers or /careers/ with nothing meaningful after)
  if (/^\/careers\/?$|^\/jobs\/?$/i.test(parsed.pathname)) {
    return { skip: true, result: _failResult("URL is a generic careers/jobs page with no job ID") };
  }

  // Known good ATS patterns — accept with high confidence without Gemini call
  if (/boards\.greenhouse\.io\/[\w-]+\/jobs\/\d+/.test(url)) {
    return { skip: true, result: _passResult(url, 0.95, "Greenhouse direct job URL pattern") };
  }
  if (/jobs\.lever\.co\/[\w-]+\/[0-9a-f-]{20,}/.test(url)) {
    return { skip: true, result: _passResult(url, 0.95, "Lever direct job URL pattern") };
  }
  if (/jobs\.ashbyhq\.com\/[\w-]+\/.+/.test(url)) {
    return { skip: true, result: _passResult(url, 0.90, "Ashby direct job URL pattern") };
  }
  if (/hiring\.cafe\/jobs\/\d+/.test(url)) {
    return { skip: true, result: _passResult(url, 0.95, "hiring.cafe direct job URL pattern") };
  }

  // No job ID at all — reject immediately
  if (!hasJobId(url)) {
    return { skip: true, result: _failResult("URL has no job ID — likely a homepage or careers page") };
  }

  // URL looks plausible — send to Gemini for full verification
  return { skip: false };
}

// ── Gemini verification ───────────────────────────────────────────────────────

async function verifyJobUrl(params) {
  const { url, expectedTitle, expectedCompany, expectedLocation, atsType, geminiClient, userId, logFn } = params;
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };

  // Pre-flight
  const preflight = preflightCheck(url, expectedTitle, expectedCompany);
  if (preflight.skip) {
    const r = preflight.result;
    if (!r.isValid) log(`[GeminiVerify] Pre-flight REJECT: ${url.slice(0, 80)} — ${r.rejectionReason}`);
    else            log(`[GeminiVerify] Pre-flight ACCEPT: ${url.slice(0, 80)} (${r.confidence})`);
    return r;
  }

  const prompt = `Verify this job posting URL.

Expected:
- Title:    ${expectedTitle}
- Company:  ${expectedCompany}
${expectedLocation ? `- Location: ${expectedLocation}` : ""}
${atsType          ? `- ATS:      ${atsType}`           : ""}

URL: ${url}

Use Google Search to:
1. Check whether the page at the URL above shows a specific job posting for "${expectedTitle}" at "${expectedCompany}".
2. If the URL is dead (404/410/redirect to homepage), search Google for the live posting and find its direct URL.
3. Is the title an exact or near-exact match (not a different seniority or department)?
4. Is the posting still active (not expired/closed/filled)?
5. Is the URL a direct posting link with a job ID — NOT a careers homepage or search page?
6. What is the salary range shown on the posting? Look for any compensation, pay range, or salary section. If not displayed, write "Not listed".

IMPORTANT for verifiedUrl:
- If the original URL is live and correct, use it as verifiedUrl.
- If the original URL is dead/wrong but Google Search found the active posting at a different URL, put that better URL in verifiedUrl and still set isValid: true.
- Never put a generic careers page or search results page in verifiedUrl.

Confidence guide:
1.0 = Exact title + company, active, direct URL with job ID
0.8 = Title slightly different but same role, active
0.6 = Related role, same company, probably active
0.4 = Wrong title or different seniority — INVALID
0.2 = Wrong company or generic page — INVALID
0.0 = Cannot find the posting anywhere — INVALID

Return ONLY a raw JSON object:
{
  "isValid": true,
  "confidence": 0.9,
  "actualTitle": "...",
  "actualCompany": "...",
  "titleSimilarity": 0.95,
  "isExpired": false,
  "salary": "$X - $Y / year",
  "rejectionReason": "",
  "verifiedUrl": "the best direct URL you found for this posting"
}`;

  try {
    const result = await geminiClient.generate({
      modelId:  geminiClient.searchModel,
      prompt,
      tools:    [{ googleSearch: {} }],
      userId,
      view:     "gemini_verify_url",
    });

    const parsed   = parseVerificationResult(result.text, url);
    parsed.isValid = parsed.confidence >= URL_CONFIDENCE_THRESHOLD && !parsed.isExpired;

    log(`[GeminiVerify] ${url.slice(0, 80)} → valid=${parsed.isValid} conf=${parsed.confidence} expired=${parsed.isExpired}`);
    return parsed;
  } catch (err) {
    log(`[GeminiVerify] ERROR: ${err.message}`);
    return _failResult(`Verification error: ${err.message}`);
  }
}

/**
 * Batch verify multiple URLs. Pre-flight runs synchronously; Gemini calls
 * run with limited concurrency.
 */
async function batchVerifyUrls(jobs, geminiClient, userId, logFn) {
  const log = (msg) => { if (logFn) logFn(msg).catch(() => {}); };
  log(`[GeminiVerify] Batch verifying ${jobs.length} URLs…`);

  // Apply pre-flight to all jobs first (no API calls)
  const preflighted = jobs.map(job => {
    const pf = preflightCheck(job.url || job.possibleJobUrl, job.title, job.company);
    return { job, preflight: pf };
  });

  const needsGemini = preflighted.filter(x => !x.preflight.skip);
  const skipGemini  = preflighted.filter(x => x.preflight.skip);

  log(`[GeminiVerify] Pre-flight: ${skipGemini.length} instant decisions, ${needsGemini.length} need Gemini`);

  // Gemini verification for ambiguous URLs — run in batches
  const geminiResults = new Map();
  for (let i = 0; i < needsGemini.length; i += VERIFY_CONCURRENCY) {
    const batch = needsGemini.slice(i, i + VERIFY_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(({ job }) => verifyJobUrl({
        url:             job.url || job.possibleJobUrl,
        expectedTitle:   job.title,
        expectedCompany: job.company,
        expectedLocation: job.location,
        atsType:         job.atsProvider,
        geminiClient,
        userId,
        logFn,
      }))
    );
    batch.forEach(({ job }, idx) => {
      geminiResults.set(job, resolved[idx]);
    });
  }

  // Merge Gemini results back
  const merged = preflighted.map(({ job, preflight }) => {
    const verification = preflight.skip
      ? preflight.result
      : (geminiResults.get(job) || _failResult("Gemini result missing"));

    return {
      ...job,
      urlVerified:        verification.isValid,
      applyUrlConfidence: verification.confidence,
      // Use salary from the live posting if Gemini found one; fall back to what search returned
      salary: (verification.salary && verification.salary !== "Not listed")
        ? verification.salary
        : (job.salary || "Not listed"),
      urlVerificationData: {
        actualTitle:     verification.actualTitle,
        titleSimilarity: verification.titleSimilarity,
        isExpired:       verification.isExpired,
        rejectionReason: verification.rejectionReason,
      },
      ...(verification.verifiedUrl && verification.verifiedUrl !== job.url
        ? { directUrl: verification.verifiedUrl }
        : {}),
    };
  });

  // HTTP liveness check — kill any Gemini-approved URL that actually 404s.
  // Run in parallel; network errors are non-fatal (treated as still-valid).
  const passedGemini = merged.filter(j => j.urlVerified);
  if (passedGemini.length > 0) {
    log(`[GeminiVerify] HTTP liveness check on ${passedGemini.length} Gemini-approved URL(s)…`);
    const livenessResults = await Promise.all(
      passedGemini.map(async job => {
        const checkUrl = job.directUrl || job.url;
        const { ok, status } = await httpLivenessCheck(checkUrl);
        if (!ok) {
          log(`[GeminiVerify] HTTP ${status} — rejecting: ${checkUrl.slice(0, 80)}`);
        }
        return { job, ok, status };
      })
    );
    // Apply liveness results back to merged array
    const deadUrls = new Set(
      livenessResults.filter(r => !r.ok).map(r => r.job.url)
    );
    for (const job of merged) {
      if (deadUrls.has(job.url)) {
        job.urlVerified        = false;
        job.applyUrlConfidence = 0;
        job.urlVerificationData = {
          ...job.urlVerificationData,
          rejectionReason: `HTTP check failed — posting appears to be removed`,
        };
      }
    }
  }

  const verified = merged.filter(j => j.urlVerified).length;
  log(`[GeminiVerify] Batch complete: ${verified}/${jobs.length} URLs verified`);
  return merged;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _failResult(reason) {
  return { isValid: false, confidence: 0, actualTitle: "", actualCompany: "",
           titleSimilarity: 0, isExpired: false, salary: "", rejectionReason: reason, verifiedUrl: null };
}

function _passResult(url, confidence, reason) {
  return { isValid: true, confidence, actualTitle: "", actualCompany: "",
           titleSimilarity: 1, isExpired: false, salary: "", rejectionReason: "", verifiedUrl: url };
}

function parseVerificationResult(rawText, fallbackUrl) {
  try {
    const clean = rawText.replace(/^```(?:json)?\s*/im, "").replace(/\s*```$/m, "").trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1) return _failResult("No JSON in response");
    const p = JSON.parse(clean.slice(start, end + 1));
    return {
      isValid:         Boolean(p.isValid),
      confidence:      typeof p.confidence      === "number" ? p.confidence      : 0,
      actualTitle:     p.actualTitle     || "",
      actualCompany:   p.actualCompany   || "",
      titleSimilarity: typeof p.titleSimilarity === "number" ? p.titleSimilarity : 0,
      isExpired:       Boolean(p.isExpired),
      salary:          p.salary          || "",
      rejectionReason: p.rejectionReason || "",
      verifiedUrl:     p.verifiedUrl     || fallbackUrl,
    };
  } catch (err) {
    return _failResult(`Parse error: ${err.message}`);
  }
}

module.exports = { verifyJobUrl, batchVerifyUrls, URL_CONFIDENCE_THRESHOLD };
