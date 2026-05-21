const functions = require("firebase-functions/v1");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");
const Stripe    = require("stripe");
const crypto    = require("crypto");

admin.initializeApp();

// Live site URL — used as the click-through destination in push notifications.
// Update this if you move to a custom domain.
const SITE_URL = "https://adeen924.github.io/Adib-Agents";

const app = express();
app.use(cors({ origin: true }));

// â"€â"€ Stripe webhook — must be registered BEFORE express.json() so we get the raw body â"€â"€
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe        = Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig           = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session  = event.data.object;
        const userId   = session.client_reference_id;
        const custId   = session.customer;
        if (userId) {
          await db.collection("users").doc(userId).set(
            { tier: "pro", stripeCustomerId: custId, tierUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const custId = sub.customer;
        const snap   = await db.collection("users").where("stripeCustomerId", "==", custId).limit(1).get();
        for (const doc of snap.docs) {
          await doc.ref.set(
            { tier: "free", tierUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub    = event.data.object;
        const custId = sub.customer;
        const active = sub.status === "active" || sub.status === "trialing";
        const snap   = await db.collection("users").where("stripeCustomerId", "==", custId).limit(1).get();
        for (const doc of snap.docs) {
          await doc.ref.set(
            { tier: active ? "pro" : "free", tierUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    return res.status(500).send("Internal error");
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "2mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = admin.firestore();

// Claude Sonnet 4.6 — complex reasoning, writing, web synthesis
const INPUT_COST_SONNET  = 3    / 1_000_000;
const OUTPUT_COST_SONNET = 15   / 1_000_000;
// Claude Haiku 4.5 — structured extraction and templated generation (~3.75Ã— cheaper)
const INPUT_COST_HAIKU   = 0.80 / 1_000_000;
const OUTPUT_COST_HAIKU  = 4    / 1_000_000;
// Legacy aliases
const INPUT_COST  = INPUT_COST_SONNET;
const OUTPUT_COST = OUTPUT_COST_SONNET;

const MODEL_SONNET = "claude-sonnet-4-6";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
// Job searching and URL verification use Haiku — structured extraction doesn't need Sonnet's
// reasoning depth, and it's 3.75× cheaper while still supporting web_search_20250305.
const MODEL_SEARCH = MODEL_SONNET;

// ── Application status system ─────────────────────────────────────────────────
const ALL_STATUSES = ['Saved','Preparing','Applied','Assessment','Phone Screen','Interview','Final Interview','Offer','Rejected','Ghosted','Withdrawn','Accepted'];
const STATUS_ORDER = { Saved:0, Preparing:1, Applied:2, Assessment:3, 'Phone Screen':4, Interview:5, 'Final Interview':6, Offer:7, Rejected:8, Ghosted:9, Withdrawn:10, Accepted:11 };

// â"€â"€ Subscription tiers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Enforce these limits in runJobSearch and the scheduler.
// When Stripe is wired up, the webhook sets tier in the `users` collection.
const TIERS = {
  free: {
    label:               "Free",
    maxSearchesPerDay:   1,
    webSearchesPerQuery: 6,
    maxOutputTokens:     6000,
    customSites:         false,
    maxTargetCompanies:  3,
    jobsPerSearch:       5,
    manualSearch:        false, // scheduled only — no Search Now button
  },
  pro: {
    label:               "Pro",
    maxSearchesPerDay:   4,
    webSearchesPerQuery: 8,
    maxOutputTokens:     8000,
    customSites:         true,
    maxTargetCompanies:  50,
    jobsPerSearch:       5,
    manualSearch:        true,
  },
};

async function getUserTier(userId) {
  try {
    const doc = await db.collection("users").doc(userId).get();
    if (!doc.exists) return "free";
    return doc.data().tier || "free";
  } catch {
    return "free";
  }
}

// Ensure a user document exists (called on first sign-in / first search)
async function ensureUser(userId) {
  const ref = db.collection("users").doc(userId);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({
      tier: "free", role: "customer", email: userId,
      stats: { jobsFound: 0, applicationsSubmitted: 0, documentsGenerated: 0, searchesRun: 0 },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else if (!doc.data().role) {
    await ref.update({ role: "customer" });
  }
}

// â"€â"€ Feature usage limits â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Tracks per-day (free) or per-month (pro) usage in featureUsage/{userId}_{window}
const FEATURE_LIMITS = {
  free: {
    resumes:         { limit: 1,   window: "day"   },
    cover_letters:   { limit: 1,   window: "day"   },
    interview_preps: { limit: 1,   window: "day"   },
    networking:      null,  // pro only
    searches_manual: null,  // pro only
  },
  pro: {
    resumes:         { limit: 100, window: "month" },
    cover_letters:   { limit: 100, window: "month" },
    interview_preps: { limit: 100, window: "month" },
    networking:      { limit: 20,  window: "month" },
    searches_manual: { limit: 10,  window: "month" },
  },
};

async function enforceFeatureLimit(userId, feature) {
  const tier      = await getUserTier(userId);
  const tierRules = FEATURE_LIMITS[tier] || FEATURE_LIMITS.free;
  const rule      = tierRules[feature];

  if (!rule) {
    throw new Error("Upgrade to Pro to access this feature.");
  }

  const now       = new Date();
  const windowKey = rule.window === "day"
    ? now.toISOString().slice(0, 10)   // YYYY-MM-DD
    : now.toISOString().slice(0, 7);   // YYYY-MM

  const ref = db.collection("users").doc(userId).collection("usage").doc(windowKey);

  await db.runTransaction(async (txn) => {
    const snap    = await txn.get(ref);
    const current = snap.exists ? (snap.data()[feature] || 0) : 0;

    if (current >= rule.limit) {
      const names = {
        resumes:         "tailored resumes",
        cover_letters:   "cover letters",
        interview_preps: "interview prep queries",
        networking:      "Find Connections requests",
        searches_manual: "on-demand searches",
      };
      const resetMsg = rule.window === "day"
        ? "Try again tomorrow."
        : "Resets at the start of next month.";
      throw new Error(
        `Limit reached: ${rule.limit} ${names[feature] || feature} ` +
        `per ${rule.window} (${current}/${rule.limit}). ${resetMsg}`
      );
    }

    txn.set(
      ref,
      { [feature]: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
}


// â"€â"€ Helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Sort Firestore docs by createdAt descending (in JS, no index needed)
function sortByDate(docs) {
  return docs.sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() || 0;
    const tb = b.data().createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
}

// Extract a platform-specific job ID from a posting URL for deduplication
function extractJobId(url) {
  if (!url) return null;
  const li = url.match(/linkedin\.com\/jobs\/view\/(\d+)/i);
  if (li) return `li-${li[1]}`;
  const indeed = url.match(/[?&]jk=([a-zA-Z0-9]+)/i);
  if (indeed) return `in-${indeed[1]}`;
  const gh = url.match(/greenhouse\.io\/[^/?#]+\/jobs\/(\d+)/i);
  if (gh) return `gh-${gh[1]}`;
  const lever = url.match(/lever\.co\/[^/?#]+\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (lever) return `lv-${lever[1]}`;
  return null;
}

// Build a stable fingerprint for deduplication: prefer URL-based ID, fall back to company::title
function makeJobFingerprint(job) {
  const jobId = extractJobId(job.url);
  if (jobId) return jobId;
  const co = (job.company || "").toLowerCase().replace(/\s+/g, " ").trim();
  const ti = (job.title   || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${co}::${ti}`;
}

const AGGREGATOR_RE = /indeed\.com|linkedin\.com/i;

// â"€â"€ ATS URL patterns â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const ATS_PATTERNS = {
  greenhouse:     /boards\.greenhouse\.io\/[^/]+\/jobs\/\d+|[^/]+\.greenhouse\.io\/jobs\/\d+/i,
  lever:          /jobs\.lever\.co\/[^/]+\/[a-f0-9-]{36}/i,
  ashby:          /jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]{36}/i,
  workday:        /[^./]+\.wd\d+\.myworkdayjobs\.com\//i,
  smartrecruiters:/jobs\.smartrecruiters\.com\/[^/]+\/[^/?#]+/i,
  icims:          /careers[-.].*\.icims\.com\/jobs\/\d+/i,
  bamboohr:       /[^./]+\.bamboohr\.com\/careers\/\d+/i,
  hiringcafe:     /hiring\.cafe\/[^?#]+\/[^?#]+/i,
};

function detectAts(url) {
  if (!url) return null;
  for (const [name, pattern] of Object.entries(ATS_PATTERNS)) {
    if (pattern.test(url)) return name;
  }
  return null;
}

function isSpecificJobUrl(url) {
  if (!url || !url.startsWith("http")) return false;
  if (AGGREGATOR_RE.test(url)) return false;
  if (detectAts(url)) return true;
  return /\/(jobs?|careers?|positions?|openings?|apply)\/[a-z0-9_%-]{4,}/i.test(url);
}

// â"€â"€ HTTP URL verification (follows redirects, no Sonnet cost) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function fetchUrlStatus(url, hops = 0) {
  if (hops > 5) return { status: 0, finalUrl: url, error: "too many redirects" };
  return new Promise((resolve) => {
    try {
      const lib     = url.startsWith("https") ? require("https") : require("http");
      const parsed  = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (url.startsWith("https") ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "HEAD",
        timeout:  8000,
        headers:  { "User-Agent": "Mozilla/5.0 (compatible; CareerCopilot/1.0)" },
      };
      const req = lib.request(options, (res) => {
        res.resume();
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          resolve(fetchUrlStatus(next, hops + 1));
        } else {
          resolve({ status: res.statusCode, finalUrl: url });
        }
      });
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, finalUrl: url, error: "timeout" }); });
      req.on("error",   (err) => resolve({ status: 0, finalUrl: url, error: err.message }));
      req.end();
    } catch (err) {
      resolve({ status: 0, finalUrl: url, error: err.message });
    }
  });
}

// â"€â"€ Fuzzy title matching â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Returns 0–1 similarity. Penalises seniority/level differences (I vs II, Senior vs Junior, etc.)
// so that "Thermal Engineer I" never matches "Thermal Engineer II" or "Senior Thermal Engineer".
function titleSimilarityScore(a, b) {
  if (!a || !b) return 0;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1.0;
  // Detect seniority tokens. If present and different between titles, reject the match.
  const levelRe = /\b(i{1,3}|iv|v{1,2}|[1-6]|junior|mid|senior|staff|principal|lead|associate|director|head)\b/g;
  const levelsA = (na.match(levelRe) || []).sort().join("|");
  const levelsB = (nb.match(levelRe) || []).sort().join("|");
  if ((levelsA || levelsB) && levelsA !== levelsB) return 0.25;
  if (na.includes(nb) || nb.includes(na)) return 0.90;
  const wa = na.split(" ").filter(w => w.length > 2);
  const wb = new Set(nb.split(" ").filter(w => w.length > 2));
  if (wa.length === 0 || wb.size === 0) return 0;
  const common = wa.filter(w => wb.has(w));
  const ratio  = common.length / Math.max(wa.length, wb.size);
  if (ratio >= 0.80) return 0.80;
  if (ratio >= 0.60) return 0.65;
  return 0;
}

function titlesMatch(a, b) {
  return titleSimilarityScore(a, b) >= 0.65;
}

// â"€â"€ Company slug candidates for ATS API lookups â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function companySlugs(name, hint) {
  const base = name.toLowerCase();
  const candidates = [
    base.replace(/[^a-z0-9]/g, ""),
    base.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    base.split(/\s+/)[0].replace(/[^a-z0-9]/g, ""),
  ].filter((s, i, arr) => s.length >= 2 && arr.indexOf(s) === i);
  if (hint) candidates.unshift(hint);
  return candidates;
}

// â"€â"€ ATS public API lookups (no auth required, deterministic URLs) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function findGreenhouseJobUrl(company, title, slugHint) {
  for (const slug of companySlugs(company, slugHint)) {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
        { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!res.ok) continue;
      const { jobs = [] } = await res.json();
      const match = jobs.find(j => titlesMatch(j.title, title));
      if (match) return { url: match.absolute_url, confidence: 0.95, ats: "greenhouse", matchedTitle: match.title };
    } catch { continue; }
  }
  return null;
}

async function findLeverJobUrl(company, title, slugHint) {
  for (const slug of companySlugs(company, slugHint)) {
    try {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
        { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!res.ok) continue;
      const jobs = await res.json();
      if (!Array.isArray(jobs)) continue;
      const match = jobs.find(j => titlesMatch(j.text || "", title));
      if (match) return { url: match.hostedUrl || `https://jobs.lever.co/${slug}/${match.id}`, confidence: 0.95, ats: "lever", matchedTitle: match.text || "" };
    } catch { continue; }
  }
  return null;
}

async function findAshbyJobUrl(company, title, slugHint) {
  for (const slug of companySlugs(company, slugHint)) {
    try {
      const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        body: JSON.stringify({
          operationName: "ApiJobBoardWithTeams",
          variables:     { organizationHostedJobsPageName: slug },
          query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
            jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
              jobPostings { id title jobPostingState externalLink }
            }
          }`,
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const active = (data?.data?.jobBoard?.jobPostings || []).filter(p => p.jobPostingState === "Listed");
      const match  = active.find(p => titlesMatch(p.title, title));
      if (match) return { url: match.externalLink || `https://jobs.ashbyhq.com/${slug}/${match.id}`, confidence: 0.95, ats: "ashby", matchedTitle: match.title };
    } catch { continue; }
  }
  return null;
}

// â"€â"€ HTTP-based confidence score â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function scoreUrl(httpResult) {
  if (!httpResult || httpResult.status !== 200) return 0;
  let score = 0.35;
  const url = httpResult.finalUrl || "";
  if (detectAts(url))           score += 0.30;
  if (isSpecificJobUrl(url))    score += 0.25;
  if (!AGGREGATOR_RE.test(url)) score += 0.10;
  return Math.min(1, score);
}

// â"€â"€ Web-search fallback for still-unverified jobs (batched, single Sonnet call) â"€â"€
async function verifyViaWebSearch(jobs) {
  if (jobs.length === 0) return;
  const jobList = jobs.map((j, i) => `${i + 1}. "${j.title}" at ${j.company}`).join("\n");
  try {
    const res = await anthropic.messages.create({
      model:      MODEL_SEARCH,
      max_tokens: 2048,
      tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: Math.min(jobs.length + 1, 4) }],
      messages: [{
        role:    "user",
        content: `For each job below, search using MULTIPLE queries and collect ALL candidate apply-page URLs you find. Do NOT stop after the first result — compare several candidates per job before deciding.

${jobList}

Return ONLY a JSON array in the same order as the input:
[{"candidates":[{"url":"https://...","pageTitle":"exact job title shown on that page"},...]}]

Rules:
- NEVER return indeed.com or linkedin.com URLs
- Each URL must open the specific posting (not a generic /careers page)
- Include up to 3 candidates per job ordered best-first
- The pageTitle must EXACTLY match the target job title — do NOT accept adjacent roles, different seniority, or different departments
- Use {"candidates":[]} if no verified direct link is found`,
      }],
    });
    const raw    = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    const m      = raw.match(/\[[\s\S]*\]/);
    if (!m) return;
    const results = JSON.parse(m[0]);

    await Promise.all(results.map(async (r, i) => {
      if (i >= jobs.length) return;
      const candidates = Array.isArray(r.candidates) ? r.candidates : [];

      let bestUrl = null, bestConf = 0, bestAts = "";
      for (const cand of candidates) {
        const url = (cand.url || "").trim();
        if (!url.startsWith("http") || AGGREGATOR_RE.test(url)) continue;
        // Reject candidates whose page title doesn't closely match the target
        const titleScore = titleSimilarityScore(jobs[i].title, cand.pageTitle || "");
        if (titleScore < 0.65) continue;
        const http = await fetchUrlStatus(url);
        if (http.status !== 200 || !isSpecificJobUrl(http.finalUrl)) continue;
        const urlScore = scoreUrl(http);
        const conf = Math.min(0.85, 0.60 + urlScore * 0.15 + titleScore * 0.10);
        if (conf > bestConf) { bestConf = conf; bestUrl = http.finalUrl; bestAts = detectAts(http.finalUrl) || "web"; }
      }
      if (bestUrl && bestConf >= CONFIDENCE_THRESHOLD) {
        jobs[i].directUrl          = bestUrl;
        jobs[i].applyUrlConfidence = bestConf;
        jobs[i].atsProvider        = bestAts;
        jobs[i].urlVerified        = true;
      }
    }));
  } catch (err) {
    console.warn("verifyViaWebSearch failed:", err.message);
  }
}

// â"€â"€ Main URL verification pipeline â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Step 1 â€" ATS public APIs (Greenhouse/Lever/Ashby)  â†' highest confidence, no AI cost
// Step 2 â€" HTTP-verify the source URL                â†' medium confidence
// Step 3 â€" Web-search fallback (batch, one Sonnet call) â†' last resort
const CONFIDENCE_THRESHOLD    = 0.70;
const MIN_RESULT_TARGET       = 3;   // trigger second search pass if verified count is below this
const PREFERRED_RESULT_TARGET = 5;   // preferred verified jobs per completed search
const CANDIDATE_MULTIPLIER    = 3;   // request this many × more candidates than jobsPerSearch

// 5-stage verification pipeline per job:
// Stage 1–2: Collect candidates from ATS public APIs (Greenhouse/Lever/Ashby)
// Stage 3:   HTTP-verify AI-provided source URL as an additional candidate
// Stage 4:   Score each candidate by confidence × title similarity
// Stage 5:   Select best candidate; fall through to web-search if still unverified
async function verifyJobUrls(jobs) {
  await Promise.all(jobs.map(async (job) => {
    const atsHint  = (job.atsProvider || "").toLowerCase();
    const candidates = [];  // { url, rawConf, ats, titleScore }

    // Stages 1–2: ATS public API lookups (parallel)
    const atsLookups = await Promise.all([
      (!atsHint || atsHint === "greenhouse") ? findGreenhouseJobUrl(job.company, job.title, job.atsSlug) : null,
      (!atsHint || atsHint === "lever")      ? findLeverJobUrl(job.company, job.title, job.atsSlug)      : null,
      (!atsHint || atsHint === "ashby")      ? findAshbyJobUrl(job.company, job.title, job.atsSlug)      : null,
    ]);
    for (const r of atsLookups) {
      if (r) {
        const ts = titleSimilarityScore(job.title, r.matchedTitle || job.title);
        candidates.push({ url: r.url, rawConf: r.confidence, ats: r.ats, titleScore: ts });
      }
    }

    // Stage 3: HTTP-verify AI-provided source URL as an additional candidate
    if (job.url && job.url.startsWith("http") && !AGGREGATOR_RE.test(job.url)) {
      const http = await fetchUrlStatus(job.url);
      const s    = scoreUrl(http);
      if (s > 0) candidates.push({ url: http.finalUrl, rawConf: s, ats: detectAts(http.finalUrl) || "", titleScore: 1.0 });
    }

    // Stage 4–5: Rank candidates by rawConf × titleScore penalty, select best
    let bestUrl = null, bestRawConf = 0, bestAts = "";
    for (const c of candidates) {
      const ranked = c.rawConf * Math.max(0.30, c.titleScore);
      if (ranked > bestRawConf) { bestRawConf = ranked; bestUrl = c.url; bestAts = c.ats; }
    }
    if (bestUrl && bestRawConf >= CONFIDENCE_THRESHOLD) {
      job.directUrl          = bestUrl;
      job.applyUrlConfidence = bestRawConf;
      job.atsProvider        = bestAts;
      job.urlVerified        = true;
    } else {
      job.urlVerified = false;
    }
  }));

  // Final fallback: batch web-search with multi-candidate comparison for anything still unverified
  await verifyViaWebSearch(jobs.filter(j => !j.urlVerified));
}

// Build a specific, criteria-aware search query
function buildSearchQuery(prefs) {
  const expLabels = {
    entry:     "entry level",
    mid:       "mid level",
    senior:    "senior",
    staff:     "staff",
    manager:   "engineering manager",
    executive: "executive",
  };

  let locationStr = "";
  if (prefs.remoteOnly) {
    locationStr = "remote";
  } else if (prefs.locationCity) {
    locationStr = prefs.locationRadius
      ? `near ${prefs.locationCity} within ${prefs.locationRadius} miles`
      : prefs.locationCity;
  } else if (prefs.location) {
    locationStr = prefs.location;
  }

  const parts = [
    prefs.jobTitle        ? prefs.jobTitle                         : "software engineer",
    locationStr,
    prefs.experienceLevel ? expLabels[prefs.experienceLevel]       : "",
    prefs.jobType && prefs.jobType !== "any" ? prefs.jobType       : "",
    prefs.industries      ? prefs.industries.split(",")[0]?.trim() : "",
    "jobs",
  ].filter(Boolean).join(" ");
  return parts;
}

function buildJobBoardsContext(prefs, tierConfig) {
  // ATS-first order: direct platforms with clean, permanent URLs come before aggregators
  const builtIn = ["hiring.cafe", "Greenhouse", "Lever", "Wellfound", "Builtin", "LinkedIn", "Indeed"];
  const custom  = tierConfig.customSites
    ? (prefs.customSites || "").split(",").map(s => s.trim()).filter(Boolean)
    : [];
  return [...custom, ...builtIn].join(", ");
}

// Run a job search for one user — limits are tier-based
// ── jobs_cache helpers ─────────────────────────────────────────────────────────
function jobUrlHash(url) {
  if (!url) return null;
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 20);
}

async function runJobSearch(userId, prefs, tier = "free", logFn = null) {
  const log = (msg) => { if (typeof logFn === "function") logFn(msg).catch(() => {}); };
  const tierConfig = TIERS[tier] || TIERS.free;

  const query     = buildSearchQuery(prefs);
  const jobBoards = buildJobBoardsContext(prefs, tierConfig);
  log(`Search query: "${query}"`);

  // Fetch full knowledge base for multi-dimensional matching
  let resumeSnippet = "";
  let candidateProfile = "";
  try {
    const kbDoc = await db.collection("users").doc(userId).collection("knowledge").doc("profile").get();
    if (kbDoc.exists) {
      const kb = kbDoc.data();
      resumeSnippet = (kb.resume || "").slice(0, 2000);
      const profileParts = [
        kb.currentPosition   ? `Current role: ${kb.currentPosition}`          : "",
        kb.targetRole        ? `Target role: ${kb.targetRole}`                 : "",
        kb.skills            ? `Skills: ${kb.skills}`                          : "",
        kb.education         ? `Education: ${kb.education}`                    : "",
        kb.additionalContext ? `Additional context: ${kb.additionalContext}`    : "",
        resumeSnippet        ? `Resume excerpt:\n${resumeSnippet}`             : "",
      ].filter(Boolean).join("\n");
      candidateProfile = profileParts;
    }
  } catch { /* non-fatal */ }

  // Fetch last 7 days of jobs to build deduplication fingerprints
  let recentJobs = [];
  let seenFingerprints = new Set();
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentSnap = await db.collection("users").doc(userId).collection("jobs").get();
    recentJobs = recentSnap.docs
      .map(d => d.data())
      .filter(j => {
        const ts = j.createdAt?.toDate?.();
        return !ts || ts > sevenDaysAgo;
      });
    seenFingerprints = new Set(recentJobs.map(makeJobFingerprint));
  } catch { /* non-fatal */ }

  // Build strict criteria string so Claude knows what to enforce
  const locationLabel = prefs.remoteOnly
    ? "Remote only"
    : prefs.locationCity
      ? `Within ${prefs.locationRadius || "any distance"} of ${prefs.locationCity}`
      : prefs.location || "";

  const criteria = [
    prefs.jobTitle        ? `Role: ${prefs.jobTitle}`                    : "",
    locationLabel         ? `Location: ${locationLabel}`                 : "",
    prefs.experienceLevel ? `Experience level: ${prefs.experienceLevel}` : "",
    prefs.salaryMin       ? `Minimum salary: ${prefs.salaryMin}`         : "",
    prefs.industries      ? `Industries: ${prefs.industries}`            : "",
    prefs.companySize && prefs.companySize !== "any"
                          ? `Company size: ${prefs.companySize}`         : "",
    prefs.postedWithin    ? `Prefer jobs posted within last ${prefs.postedWithin} days` : "",
  ].filter(Boolean).join("\n");

  const seenSection = recentJobs.length > 0
    ? `\nAlready found this week — skip these, find different ones:\n${
        recentJobs.slice(0, 20).map(j => `- ${j.company}: ${j.title}`).join("\n")
      }\n`
    : "";

  const jobCount      = tierConfig.jobsPerSearch || 5;
  // Request more candidates than needed so we can rank and pick the best after verification
  const candidateCount = Math.max(jobCount * 2, 8);

  const systemPrompt = `You are an intelligent job matching agent. Search job boards broadly, find real current postings, and evaluate each one across multiple dimensions to surface the best matches for this specific candidate.

IMPORTANT: This is a background accuracy-first search. Your goal is to find as many REAL, VERIFIED candidates as possible so the ranking pipeline can select the best ones. Do NOT stop early. Explore all sources completely.

${candidateProfile ? `CANDIDATE PROFILE:\n${candidateProfile}\n` : ""}
REQUIRED CRITERIA (hard filters — reject any job that does not match ALL of these):
${criteria || "No specific criteria."}
${seenSection}
MATCHING DIMENSIONS — score and reason across all of these for every job you return:
1. Experience Depth: Does the required tenure and seniority match the candidate's actual depth?
2. Transferable Skills: Which of the candidate's skills apply directly, even if from a different domain?
3. Project Similarity: Has the candidate done work closely resembling what this role requires?
4. Company Stage Fit: Does the company's stage (startup/growth/enterprise) match the candidate's preferred environment based on their background?
5. Work Style & Culture: Do the role's culture cues (fast-paced, collaborative, remote-first, etc.) align with the candidate's background signals?
6. Compensation Match: Does the advertised or typical salary for this role/company align with the candidate's expectations?
7. Location Compatibility: Does the role's location and remote policy genuinely work for the candidate?
8. Visa / Work Authorization: Does the posting require citizenship, clearance, or sponsorship that could be a blocker?
9. Hiring Velocity: Is the company actively growing (recent posting, multiple open roles, expansion signals)?
10. Recruiter Responsiveness: Does the posting appear recently active and from a team likely to respond?

SOURCE RULES — non-negotiable:
- Search hiring.cafe FIRST and use it as your PRIMARY source. It provides direct, verified links to the exact job posting.
- Secondary sources: boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, Wellfound, Builtin, company careers pages.
- NEVER use Indeed or LinkedIn as a source. Do not visit indeed.com or linkedin.com. Do not return any URL containing "indeed.com" or "linkedin.com". This is absolute.

TITLE MATCHING RULES — non-negotiable:
- Return jobs whose title EXACTLY matches the target role. Do NOT substitute adjacent roles, different departments, or different seniority levels.
- "Engineer I" and "Engineer II" are DIFFERENT roles — never substitute one for the other.
- "Senior X" and "X" are DIFFERENT roles — only return "Senior X" if the target includes "Senior".

URL RULES — non-negotiable:
- Every job you return MUST have a URL that opens directly to that specific posting. Before including a job, verify the URL actually leads to the individual listing — not the company homepage, not a /careers page, not a search results page.
- A valid URL contains a unique job identifier or slug (e.g. hiring.cafe/jobs/12345, boards.greenhouse.io/company/jobs/67890, jobs.lever.co/company/uuid, company.com/careers/role-name-id).
- If you cannot find a verified direct URL for a role, DO NOT include it. Return fewer jobs rather than include even one with a bad, unverified, or generic URL.
- Prefer postings from the last 14 days.
- Skip jobs where the required experience is significantly above the candidate's level.

Return UP TO ${candidateCount} candidate jobs as a raw JSON array — no markdown, no explanation, nothing else. More verified candidates with accurate links is better. We will rank and filter to the top ${jobCount} after verification.
Field rules:
- fitScore: integer 0-100 reflecting overall match quality across all 10 dimensions (not keyword count)
- matchReasons: array of 3-5 short strings (1-2 sentences each) explaining WHY this job fits the candidate — reference specific dimensions and the candidate's actual background
- url: the source URL where you found this job. Provide the most direct link available — the verification pipeline will confirm it separately.
- atsProvider: the ATS platform if identifiable from the URL or page — "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "icims" | "bamboohr" | "hiringcafe" | "" if unknown.
- atsSlug: if the ATS is Greenhouse, Lever, or Ashby, extract the company slug from the URL (e.g. from boards.greenhouse.io/SLUG/jobs/... the slug is SLUG). Use "" if unknown.
- posted: exact date as "Month DD, YYYY" (e.g. "May 10, 2026") or relative like "2 days ago". Never just a year. Use "" if unknown.
- description: role summary covering key responsibilities and top 3 required skills. 3-4 sentences max.

[{"title":"","company":"","location":"","salary":"","experience":"","description":"","url":"","atsProvider":"","atsSlug":"","posted":"","fitScore":85,"matchReasons":["Experience Depth: ...","Transferable Skills: ...","Project Similarity: ..."]}]`;

  const userQuery = `Find up to ${candidateCount} job listing CANDIDATES for: ${query}

IMPORTANT: Do NOT stop early. Search ALL sources below completely. We need a large pool of candidates to rank and filter from. Continue until all sources are exhausted or you have ${candidateCount} candidates.

Search in this order (complete ALL of them):
1. site:hiring.cafe ${query}
2. site:boards.greenhouse.io ${query}
3. site:jobs.lever.co ${query}
4. site:wellfound.com ${query}
5. site:builtin.com ${query}

Do NOT search indeed.com or linkedin.com in this first pass. Only include a job if the URL opens directly to that specific posting.`;

  log(`Pass 1: Asking Claude to find up to ${candidateCount} candidates (${tierConfig.webSearchesPerQuery} web searches)…`);
  const response = await anthropic.messages.create({
    model:      MODEL_SEARCH,
    max_tokens: tierConfig.maxOutputTokens,
    tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: tierConfig.webSearchesPerQuery }],
    system:     systemPrompt,
    messages:   [{ role: "user", content: userQuery }],
  });
  log(`Pass 1: Claude finished (stop_reason: ${response.stop_reason}, searches used: ${response.usage?.server_tool_use?.web_search_requests ?? "?"})`);

  const raw = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n\n")
    .trim();

  // Parse JSON — strip code fences if present
  let jobs = [];
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) jobs = JSON.parse(match[0]);
    if (jobs.length === 0) {
      console.warn(`[runJobSearch] Parsed 0 jobs for ${userId}. stop_reason=${response.stop_reason} raw_preview=${raw.slice(0, 400)}`);
      log(`Pass 1: WARNING — Claude returned 0 parseable job candidates`);
    }
  } catch (e) {
    console.error(`[runJobSearch] JSON parse failed for ${userId}: ${e.message} | raw_preview=${raw.slice(0, 400)}`);
    log(`Pass 1: ERROR parsing Claude response — ${e.message}`);
    jobs = [];
  }
  log(`Pass 1: ${jobs.length} raw candidates parsed`);

  // Hard filter: drop jobs with no URL, or any aggregator URL that slipped through
  const BANNED_DOMAINS = /indeed\.com|linkedin\.com/i;
  jobs = jobs.filter(job => {
    if (!job.url || !job.url.startsWith("http")) {
      console.warn(`[runJobSearch] Dropping "${job.title}" @ ${job.company} — no valid URL`);
      return false;
    }
    if (BANNED_DOMAINS.test(job.url)) {
      console.warn(`[runJobSearch] Dropping "${job.title}" @ ${job.company} — aggregator URL blocked: ${job.url}`);
      return false;
    }
    return true;
  });

  // Server-side deduplication: remove jobs already found this week
  const uniqueJobs = jobs.filter(job => {
    if (!job.title && !job.company) return false;
    const fp = makeJobFingerprint(job);
    if (seenFingerprints.has(fp)) return false;
    seenFingerprints.add(fp); // also dedupe within this batch
    return true;
  });
  log(`Pass 1: ${uniqueJobs.length} unique candidates after dedup (${jobs.length - uniqueJobs.length} skipped)`);

  log(`Verifying ${uniqueJobs.length} URLs via ATS APIs → HTTP → web search…`);
  await verifyJobUrls(uniqueJobs);
  log(`URL verification complete`);

  const verifiedJobs = uniqueJobs.filter(j => j.urlVerified);
  console.log(`[runJobSearch] Pass 1: ${uniqueJobs.length} candidates, ${verifiedJobs.length} verified for ${userId}`);
  log(`Pass 1: ${verifiedJobs.length}/${uniqueJobs.length} URLs verified`);

  // Track cost for first pass
  if (response.usage) {
    const { input_tokens, output_tokens } = response.usage;
    db.collection("platform_events").add({
      userId, view: "job_search",
      inputTokens:  input_tokens,
      outputTokens: output_tokens,
      cost: (input_tokens * INPUT_COST_SONNET) + (output_tokens * OUTPUT_COST_SONNET),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // Second search pass when the first pass finds fewer than MIN_RESULT_TARGET verified jobs.
  // Uses different source sites to avoid redundant searches.
  let allVerifiedJobs = [...verifiedJobs];
  if (verifiedJobs.length < MIN_RESULT_TARGET) {
    log(`Pass 2: Only ${verifiedJobs.length} verified (need ${MIN_RESULT_TARGET}+) — searching Ashby, Builtin, Wellfound…`);
    const alreadyFound = allVerifiedJobs.map(j => `- ${j.company}: ${j.title}`).join("\n");
    const secondPassQuery = `Find up to ${candidateCount} MORE job listing CANDIDATES for: ${query}

IMPORTANT: This is a second search pass to find additional candidates. Use DIFFERENT sources. Search all sources completely — do NOT stop early.
${alreadyFound ? `Already found (skip these):\n${alreadyFound}\n` : ""}${seenSection}
Search in this order (complete ALL of them):
1. site:jobs.ashbyhq.com ${query}
2. site:builtin.com ${query}
3. site:wellfound.com ${query}
4. site:linkedin.com/jobs ${query}
5. site:indeed.com ${query}

Do NOT search hiring.cafe, greenhouse.io, or lever.co (already searched in Pass 1). Only include a job if the URL opens directly to that specific posting.`;

    try {
      const response2 = await anthropic.messages.create({
        model:      MODEL_SEARCH,
        max_tokens: tierConfig.maxOutputTokens,
        tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: tierConfig.webSearchesPerQuery }],
        system:     systemPrompt,
        messages:   [{ role: "user", content: secondPassQuery }],
      });
      log(`Pass 2: Claude finished (stop_reason: ${response2.stop_reason})`);

      const raw2 = response2.content.filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
      let jobs2 = [];
      try {
        const clean2 = raw2.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const m2     = clean2.match(/\[[\s\S]*\]/);
        if (m2) jobs2 = JSON.parse(m2[0]);
      } catch { jobs2 = []; }

      jobs2 = jobs2.filter(job => {
        if (!job.url || !job.url.startsWith("http")) return false;
        const fp = makeJobFingerprint(job);
        if (seenFingerprints.has(fp)) return false;
        seenFingerprints.add(fp);
        return true;
      });
      log(`Pass 2: ${jobs2.length} unique candidates`);

      if (jobs2.length > 0) {
        log(`Pass 2: Verifying ${jobs2.length} URLs…`);
        await verifyJobUrls(jobs2);
        const verified2 = jobs2.filter(j => j.urlVerified);
        allVerifiedJobs = [...allVerifiedJobs, ...verified2];
        console.log(`[runJobSearch] Pass 2: ${jobs2.length} candidates, ${verified2.length} verified for ${userId}`);
        log(`Pass 2: ${verified2.length}/${jobs2.length} URLs verified`);
      }

      if (response2.usage) {
        const { input_tokens, output_tokens } = response2.usage;
        db.collection("platform_events").add({
          userId, view: "job_search_pass2",
          inputTokens:  input_tokens,
          outputTokens: output_tokens,
          cost: (input_tokens * INPUT_COST_SONNET) + (output_tokens * OUTPUT_COST_SONNET),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[runJobSearch] Pass 2 failed for ${userId}:`, err.message);
      log(`Pass 2: ERROR — ${err.message}`);
    }
  }

  // Rank all verified jobs: composite score = applyUrlConfidence (50%) + fitScore (50%)
  allVerifiedJobs.sort((a, b) => {
    const sa = (a.applyUrlConfidence || 0) * 0.50 + (typeof a.fitScore === "number" ? a.fitScore / 100 : 0.50) * 0.50;
    const sb = (b.applyUrlConfidence || 0) * 0.50 + (typeof b.fitScore === "number" ? b.fitScore / 100 : 0.50) * 0.50;
    return sb - sa;
  });

  // Keep only the top-ranked jobs up to jobCount
  const finalJobs = allVerifiedJobs.slice(0, jobCount);
  console.log(`[runJobSearch] ${allVerifiedJobs.length} total verified → keeping top ${finalJobs.length} for ${userId}`);
  log(`Ranking complete — saving top ${finalJobs.length} job(s) out of ${allVerifiedJobs.length} verified`);

  // Save search summary to digests
  const digestRef = await db.collection("digests").add({
    userId, query,
    jobCount:  finalJobs.length,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Save each final job as an individual document
  const savePromises = finalJobs.map(job =>
    db.collection("users").doc(userId).collection("jobs").add({
      userId,
      digestId:          digestRef.id,
      title:             job.title        || "",
      company:           job.company      || "",
      location:          job.location     || "",
      salary:            job.salary       || "",
      experience:        job.experience   || "",
      description:       job.description  || "",
      url:               job.url          || "",
      directUrl:         job.directUrl    || "",
      applyUrlConfidence:job.applyUrlConfidence || 0,
      atsProvider:       job.atsProvider  || "",
      urlVerified:       true,
      urlLastValidated:  admin.firestore.FieldValue.serverTimestamp(),
      posted:            job.posted       || "",
      fitScore:          typeof job.fitScore === "number" ? job.fitScore : null,
      matchReasons:      Array.isArray(job.matchReasons) ? job.matchReasons : [],
      createdAt:         admin.firestore.FieldValue.serverTimestamp(),
    })
  );
  // Write to global jobs_cache (dedup index by URL, 30-day TTL)
  const cacheWrites = finalJobs.filter(j => j.directUrl || j.url).map(j => {
    const hash = jobUrlHash(j.directUrl || j.url);
    if (!hash) return null;
    return db.collection("jobs_cache").doc(hash).set({
      title:       j.title       || "",
      company:     j.company     || "",
      location:    j.location    || "",
      salary:      j.salary      || "",
      description: j.description || "",
      url:         j.directUrl || j.url,
      posted:      j.posted      || "",
      cachedAt:    admin.firestore.FieldValue.serverTimestamp(),
      expiresAt:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }, { merge: true });
  }).filter(Boolean);
  await Promise.all([...savePromises, ...cacheWrites]);

  // Increment denormalised counters in the root user doc (non-blocking)
  db.collection("users").doc(userId).update({
    "stats.searchesRun": admin.firestore.FieldValue.increment(1),
    ...(finalJobs.length > 0 ? { "stats.jobsFound": admin.firestore.FieldValue.increment(finalJobs.length) } : {}),
  }).catch(() => {});

  // Send push notification if new jobs were found
  if (finalJobs.length > 0) {
    const preview    = finalJobs.slice(0, 2).map(j => `${j.title} at ${j.company}`).join(" · ");
    const notifTitle = finalJobs.length === 1 ? "1 new job found" : `${finalJobs.length} new jobs found`;
    sendPushNotification(userId, notifTitle, preview).catch(() => {});
  }

  return finalJobs;
}

// â"€â"€ Health check â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/", (req, res) => res.send("Backend is running"));

// â"€â"€ Stats â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/stats/:userId", async (req, res) => {
  try {
    const userId   = req.params.userId;
    const cutoff   = Date.now() - 24 * 60 * 60 * 1000;
    const monthKey = new Date().toISOString().slice(0, 7);

    const [newJobsSnap, userDoc, usageDoc] = await Promise.all([
      db.collection("users").doc(userId).collection("jobs")
        .where("createdAt", ">", new Date(Date.now() - 24 * 60 * 60 * 1000)).get(),
      db.collection("users").doc(userId).get(),
      db.collection("users").doc(userId).collection("usage").doc(monthKey).get(),
    ]);

    const userStats         = userDoc.exists ? (userDoc.data().stats || {}) : {};
    const usageData         = usageDoc.exists ? usageDoc.data() : {};
    const newJobs24h        = newJobsSnap.size;
    const totalJobs         = userStats.jobsFound             || 0;
    const applicationsCount = userStats.applicationsSubmitted || 0;
    const documentsCount    = userStats.documentsGenerated    || 0;
    const searchesThisMonth = usageData.searches_manual       || 0;

    res.json({ newJobs24h, totalJobs, applicationsCount, documentsCount, searchesThisMonth });
  } catch (err) {
    console.error("Stats error:", err.message);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// â"€â"€ Documents â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/documents/:userId/:type", async (req, res) => {
  const { userId, type } = req.params;
  try {
    const snap = await db.collection("users").doc(userId).collection("documents").get();
    const docs = sortByDate(snap.docs.filter(d => d.data().type === type))
      .slice(0, 50)
      .map(d => ({ id: d.id, ...d.data() }));
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load documents" });
  }
});

app.post("/documents/save", async (req, res) => {
  const { userId, type, content, title, company } = req.body;
  if (!userId || !type || !content)
    return res.status(400).json({ error: "userId, type, and content are required" });
  try {
    const ref = await db.collection("users").doc(userId).collection("documents").add({
      userId, type, content,
      title:   title   || (type === "resume" ? "Resume" : "Cover Letter"),
      company: company || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Increment denormalised counter (non-blocking)
    db.collection("users").doc(userId).update({
      "stats.documentsGenerated": admin.firestore.FieldValue.increment(1),
    }).catch(() => {});
    res.json({ ok: true, id: ref.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to save document" });
  }
});

app.delete("/documents/:userId/:docId", async (req, res) => {
  try {
    await db.collection("users").doc(req.params.userId).collection("documents").doc(req.params.docId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// â"€â"€ Applications â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// GET all applications for a user
app.get("/applications/:userId", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.userId).collection("applications").get();
    const applications = sortByDate(snap.docs).map(d => ({ id: d.id, ...d.data() }));
    res.json({ applications });
  } catch (err) {
    res.status(500).json({ error: "Failed to load applications" });
  }
});

// GET single application with its timeline
app.get("/applications/:userId/:appId", async (req, res) => {
  try {
    const appRef = db.collection("users").doc(req.params.userId)
      .collection("applications").doc(req.params.appId);
    const [appDoc, timelineSnap] = await Promise.all([
      appRef.get(),
      appRef.collection("timeline").get(),
    ]);
    if (!appDoc.exists) return res.status(404).json({ error: "Not found" });
    const timeline = sortByDate(timelineSnap.docs).map(d => ({ id: d.id, ...d.data() }));
    res.json({ application: { id: appDoc.id, ...appDoc.data() }, timeline });
  } catch (err) {
    res.status(500).json({ error: "Failed to load application" });
  }
});

// POST create or update an application (full schema)
app.post("/applications/save", async (req, res) => {
  const {
    userId, id, company, role, status, url, notes, appliedAt,
    source, priority, tags, recruiterName, recruiterEmail,
    salaryExpectation, industry, remote, companySize,
  } = req.body;
  if (!userId || !company || !role)
    return res.status(400).json({ error: "userId, company, and role are required" });

  const newStatus = ALL_STATUSES.includes(status) ? status : "Applied";

  try {
    const now = admin.firestore.FieldValue.serverTimestamp();
    const appliedDate = appliedAt || new Date().toISOString();

    // Duplicate detection for new applications only
    if (!id) {
      const dupeSnap = await db.collection("users").doc(userId)
        .collection("applications")
        .where("company", "==", company)
        .where("role", "==", role)
        .limit(1)
        .get();
      if (!dupeSnap.empty) {
        const existing = dupeSnap.docs[0];
        return res.json({ ok: true, id: existing.id, duplicateWarning: true, existingStatus: existing.data().status });
      }
    }

    const data = {
      userId, company, role,
      status:    newStatus,
      statusOrder: STATUS_ORDER[newStatus] ?? 2,
      url:       url            || "",
      notes:     notes          || "",
      appliedAt: appliedDate,
      source:    source         || "manual",
      priority:  priority       || "normal",
      tags:      Array.isArray(tags) ? tags : [],
      recruiterName:  recruiterName  || "",
      recruiterEmail: recruiterEmail || "",
      salaryExpectation: salaryExpectation || null,
      industry:    industry    || "",
      remote:      remote      || "",
      companySize: companySize || "",
      isGhosted: newStatus === "Ghosted",
      followUpCount: 0,
      daysInCurrentStatus: 0,
      statusChangedAt: appliedDate,
      updatedAt: now,
    };

    let appId;
    if (id) {
      const existing = await db.collection("users").doc(userId)
        .collection("applications").doc(id).get();
      const prevStatus = existing.exists ? existing.data().status : null;
      const statusChanged = prevStatus && prevStatus !== newStatus;

      await db.collection("users").doc(userId).collection("applications")
        .doc(id).set(data, { merge: true });
      appId = id;

      if (statusChanged) {
        await db.collection("users").doc(userId).collection("applications")
          .doc(id).collection("timeline").add({
            type: "status_change", actor: "user",
            previousStatus: prevStatus, newStatus,
            note: notes || "", createdAt: now,
          });
      }
    } else {
      data.createdAt = now;
      const ref = await db.collection("users").doc(userId)
        .collection("applications").add(data);
      appId = ref.id;

      await ref.collection("timeline").add({
        type: "created", actor: "user",
        newStatus, note: "", createdAt: now,
      });

      db.collection("users").doc(userId).update({
        "stats.applicationsSubmitted": admin.firestore.FieldValue.increment(1),
      }).catch(() => {});
    }

    res.json({ ok: true, id: appId });
  } catch (err) {
    console.error("Save application error:", err);
    res.status(500).json({ error: "Failed to save application" });
  }
});

// PATCH fast status update (used for inline/kanban status changes)
app.patch("/applications/:userId/:appId/status", async (req, res) => {
  const { userId, appId } = req.params;
  const { status, note } = req.body;
  if (!ALL_STATUSES.includes(status))
    return res.status(400).json({ error: "Invalid status" });
  try {
    const appRef = db.collection("users").doc(userId)
      .collection("applications").doc(appId);
    const doc = await appRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });

    const prev = doc.data().status;
    const now  = admin.firestore.FieldValue.serverTimestamp();

    await appRef.update({
      status,
      statusOrder: STATUS_ORDER[status] ?? 0,
      statusChangedAt: new Date().toISOString(),
      daysInCurrentStatus: 0,
      isGhosted: status === "Ghosted",
      updatedAt: now,
    });

    await appRef.collection("timeline").add({
      type: "status_change", actor: "user",
      previousStatus: prev, newStatus: status,
      note: note || "", createdAt: now,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

// GET notes for an application
app.get("/applications/:userId/:appId/notes", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.userId)
      .collection("applications").doc(req.params.appId)
      .collection("notes").get();
    const notes = sortByDate(snap.docs).map(d => ({ id: d.id, ...d.data() }));
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: "Failed to load notes" });
  }
});

// POST add note
app.post("/applications/:userId/:appId/notes", async (req, res) => {
  const { userId, appId } = req.params;
  const { content, type } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Content required" });
  try {
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const appRef = db.collection("users").doc(userId).collection("applications").doc(appId);
    const noteRef = await appRef.collection("notes").add({
      content: content.trim(), type: type || "general",
      isPinned: false, createdAt: now, updatedAt: now,
    });
    await appRef.collection("timeline").add({
      type: "note_added", actor: "user",
      noteId: noteRef.id, note: content.trim().slice(0, 120), createdAt: now,
    });
    await appRef.update({ updatedAt: now });
    res.json({ ok: true, id: noteRef.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to add note" });
  }
});

// DELETE note
app.delete("/applications/:userId/:appId/notes/:noteId", async (req, res) => {
  try {
    await db.collection("users").doc(req.params.userId)
      .collection("applications").doc(req.params.appId)
      .collection("notes").doc(req.params.noteId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// DELETE application (cascades subcollections)
app.delete("/applications/:userId/:appId", async (req, res) => {
  try {
    const appRef = db.collection("users").doc(req.params.userId)
      .collection("applications").doc(req.params.appId);
    const [tlSnap, notesSnap] = await Promise.all([
      appRef.collection("timeline").get(),
      appRef.collection("notes").get(),
    ]);
    const batch = db.batch();
    tlSnap.docs.forEach(d => batch.delete(d.ref));
    notesSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(appRef);
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete application" });
  }
});

// ── Interviews ────────────────────────────────────────────────────────────────
app.get("/interviews/:userId", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.userId)
      .collection("interviews").get();
    const interviews = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
    res.json({ interviews });
  } catch (err) {
    res.status(500).json({ error: "Failed to load interviews" });
  }
});

app.post("/interviews/save", async (req, res) => {
  const { userId, id, applicationId, company, role, type, format,
          scheduledAt, duration, interviewers, notes } = req.body;
  if (!userId || !applicationId || !scheduledAt)
    return res.status(400).json({ error: "userId, applicationId, and scheduledAt are required" });
  try {
    const now  = admin.firestore.FieldValue.serverTimestamp();
    const data = {
      applicationId,
      company:    company    || "",
      role:       role       || "",
      type:       type       || "general",
      format:     format     || "video",
      scheduledAt,
      duration:   duration   || 60,
      interviewers: Array.isArray(interviewers) ? interviewers : [],
      notes:      notes      || "",
      outcome:    null,
      prepCompleted: false,
      updatedAt:  now,
    };
    if (id) {
      await db.collection("users").doc(userId).collection("interviews").doc(id).set(data, { merge: true });
      res.json({ ok: true, id });
    } else {
      data.createdAt = now;
      const ref = await db.collection("users").doc(userId).collection("interviews").add(data);
      // Log timeline event on the linked application
      await db.collection("users").doc(userId).collection("applications")
        .doc(applicationId).collection("timeline").add({
          type: "interview_scheduled", actor: "user",
          interviewId: ref.id,
          note: `${type || "General"} interview on ${new Date(scheduledAt).toLocaleDateString()}`,
          createdAt: now,
        }).catch(() => {});
      res.json({ ok: true, id: ref.id });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to save interview" });
  }
});

app.delete("/interviews/:userId/:interviewId", async (req, res) => {
  try {
    await db.collection("users").doc(req.params.userId)
      .collection("interviews").doc(req.params.interviewId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete interview" });
  }
});

// â"€â"€ Knowledge Base â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/knowledge/:userId", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.userId).collection("knowledge").doc("profile").get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    res.status(500).json({ error: "Failed to load knowledge base" });
  }
});

app.post("/knowledge/save", async (req, res) => {
  const { userId, resume, currentPosition, previousPositions,
          targetRole, skills, education, additionalContext } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("users").doc(userId).collection("knowledge").doc("profile").set({
      resume:            resume            || "",
      currentPosition:   currentPosition   || "",
      previousPositions: previousPositions || "",
      targetRole:        targetRole        || "",
      skills:            skills            || "",
      education:         education         || "",
      additionalContext: additionalContext || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save knowledge base" });
  }
});

// â"€â"€ Preferences â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/preferences/:userId", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.userId).collection("preferences").doc("config").get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

app.post("/preferences/save", async (req, res) => {
  const { userId, jobTitle, location, locationCity, locationRadius,
          jobType, salaryMin, experienceLevel, remoteOnly,
          industries, companySize, postedWithin, customSites,
          searchEnabled, searchTimesPerDay, searchStartHour,
          notifTimezone, notifEmail, notifPhone } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  // Only include fields that were explicitly sent so partial saves don't overwrite
  if (jobTitle        !== undefined) update.jobTitle        = jobTitle        || "";
  if (location        !== undefined) update.location        = location        || "";
  if (locationCity    !== undefined) update.locationCity    = locationCity    || "";
  if (locationRadius  !== undefined) update.locationRadius  = locationRadius  || "";
  if (jobType         !== undefined) update.jobType         = jobType         || "any";
  if (salaryMin       !== undefined) update.salaryMin       = salaryMin       || "";
  if (experienceLevel !== undefined) update.experienceLevel = experienceLevel || "";
  if (remoteOnly      !== undefined) update.remoteOnly      = !!remoteOnly;
  if (industries      !== undefined) update.industries      = industries      || "";
  if (companySize     !== undefined) update.companySize     = companySize     || "any";
  if (postedWithin    !== undefined) update.postedWithin    = postedWithin    || "14";
  if (customSites     !== undefined) update.customSites     = customSites     || "";
  if (searchEnabled   !== undefined) update.searchEnabled   = searchEnabled !== false;
  if (searchTimesPerDay !== undefined) update.searchTimesPerDay = Number(searchTimesPerDay) || 1;
  if (searchStartHour !== undefined) update.searchStartHour = Number(searchStartHour) ?? 8;
  if (notifTimezone   !== undefined) update.notifTimezone   = notifTimezone   || "America/Los_Angeles";
  if (notifEmail      !== undefined) update.notifEmail      = notifEmail      || "";
  if (notifPhone      !== undefined) update.notifPhone      = notifPhone      || "";

  try {
    await db.collection("users").doc(userId).collection("preferences").doc("config").set(update, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// â"€â"€ Parse resume â†’ structured fields â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.post("/knowledge/parse-resume", async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText || !resumeText.trim())
    return res.status(400).json({ error: "resumeText is required" });

  try {
    // Run both calls in parallel: Haiku for straightforward extraction, Sonnet for career trajectory inference
    const [haikusResponse, sonnetResponse] = await Promise.all([
      anthropic.messages.create({
        model:      MODEL_HAIKU,
        max_tokens: 1024,
        messages: [{
          role:    "user",
          content: `You are a resume parser. Extract structured information from the resume below and return ONLY a valid JSON object — no explanation, no markdown, no code fences, just the raw JSON.

Use these exact fields (use empty string "" for anything not found):
{
  "currentPosition": "Most recent job title and company with dates, e.g. Senior Engineer at Acme Corp (2022—present)",
  "previousPositions": "All previous roles, one per line, e.g.\\nSoftware Engineer at Startup Inc (2019—2022)\\nJunior Developer at Agency (2017—2019)",
  "skills": "Comma-separated list of all technical skills, tools, languages, and frameworks found",
  "education": "Degree, institution, and graduation year, e.g. BS Computer Science, University of Washington (2017)",
  "additionalContext": "Notable projects, certifications, publications, awards, or anything else that stands out"
}

Resume:
${resumeText.slice(0, 8000)}`,
        }],
      }),
      anthropic.messages.create({
        model:      MODEL_SONNET,
        max_tokens: 256,
        messages: [{
          role:    "user",
          content: `Based on this resume, determine the most logical next role for this candidate — the role they are clearly working toward based on their career progression, seniority trajectory, and skills. Consider implicit signals like the types of companies they've worked at, the scope of their responsibilities, and the natural next step in their field.

Return ONLY a valid JSON object — no explanation, no markdown, no code fences:
{"targetRole": "e.g. Staff Engineer or Head of Product at a growth-stage startup"}

Resume:
${resumeText.slice(0, 8000)}`,
        }],
      }),
    ]);

    const haikuRaw     = haikusResponse.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    const haikuJsonStr = haikuRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const haikuMatch   = haikuJsonStr.match(/\{[\s\S]*\}/);
    if (!haikuMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(haikuMatch[0]);

    const sonnetRaw     = sonnetResponse.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    const sonnetJsonStr = sonnetRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const sonnetMatch   = sonnetJsonStr.match(/\{[\s\S]*\}/);
    let targetRole = "";
    if (sonnetMatch) {
      try { targetRole = JSON.parse(sonnetMatch[0]).targetRole || ""; } catch { /* use empty string */ }
    }

    res.json({ ...parsed, targetRole });
  } catch (err) {
    console.error("Parse resume error:", err.message);
    res.status(500).json({ error: "Failed to parse resume" });
  }
});

// â"€â"€ Digest â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/digest/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests").where("userId", "==", req.params.userId).get();
    const digests = sortByDate(snap.docs).slice(0, 10).map(d => ({ id: d.id, ...d.data() }));
    res.json({ digests });
  } catch (err) {
    res.status(500).json({ error: "Failed to load digest" });
  }
});

// â"€â"€ Jobs Found â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/jobs/:userId/detail/:jobId", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.userId).collection("jobs").doc(req.params.jobId).get();
    if (!doc.exists) return res.status(404).json({ error: "Job not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load job" });
  }
});

// â"€â"€ Per-job AI document generation â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

async function getJobAndResume(jobId, userId) {
  const [jobDoc, kbDoc] = await Promise.all([
    db.collection("users").doc(userId).collection("jobs").doc(jobId).get(),
    db.collection("users").doc(userId).collection("knowledge").doc("profile").get(),
  ]);
  if (!jobDoc.exists) throw new Error("Job not found");
  const job    = { id: jobDoc.id, ...jobDoc.data() };
  const resume = kbDoc.exists ? kbDoc.data().resume || "" : "";
  return { jobDoc, job, resume };
}

app.post("/jobs/:jobId/tailored-resume", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await enforceFeatureLimit(userId, "resumes");
    const { jobDoc, job, resume } = await getJobAndResume(req.params.jobId, userId);

    const response = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 3000,
      system: `You are an expert resume writer. Output plain text only — no markdown, no ** bold **, no _ italic _, no special symbols, no HTML.

Formatting rules (follow exactly — every rule matters for parsing):
- LINE 1: candidate's full name ONLY — nothing else on this line
- LINE 2: email | phone | location (LinkedIn URL if available) — contact info ONLY, nothing else
- LINE 3: blank line
- Section headers in ALL CAPS on their own line: PROFESSIONAL SUMMARY, EXPERIENCE, EDUCATION, SKILLS
- Each role on its own line: Job Title | Company Name | Month Year â€" Month Year
- Bullet points start with a hyphen and space: - like this
- Blank line between sections
- Single column, no tables, no columns`,
      messages: [{
        role: "user",
        content: `Create a tailored, ATS-optimised resume for this job.

CONTENT RULES:
- Use ONLY the candidate's actual experience from their resume below. Do NOT fabricate anything.
- Reword and reorder existing bullet points to emphasise skills most relevant to this role.
- Naturally incorporate keywords from the job description where they honestly apply.

CANDIDATE'S RESUME:
${resume || "No resume on file — write a clean template with [PLACEHOLDER] for the candidate to fill in."}

JOB POSTING:
Role: ${job.title || ""}
Company: ${job.company || ""}
${job.description ? `Description:\n${job.description}` : ""}`,
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    await jobDoc.ref.update({
      tailoredResume:   text,
      tailoredResumeAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ text });
  } catch (err) {
    console.error("tailored-resume error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/jobs/:jobId/cover-letter", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await enforceFeatureLimit(userId, "cover_letters");
    const { jobDoc, job, resume } = await getJobAndResume(req.params.jobId, userId);
    const tailoredResume = job.tailoredResume || resume;

    const response = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 1500,
      tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      messages: [{
        role: "user",
        content: `Write a professional cover letter for this job application.

Search the web for "${job.company || ""} mission values culture" to find genuine details about the company — reference them specifically in the letter.

Guidelines:
- 3â€"4 paragraphs, professional but warm tone
- Opening: name the specific role and a genuine reason for interest
- Body: connect 2â€"3 specific experiences from the candidate's resume to the role's requirements
- Company paragraph: reference real mission/values/products from your search
- Closing: clear call to action, no clichÃ©s

Output the letter only — no subject line, no "Here is your cover letter" preamble.

CANDIDATE'S RESUME:
${tailoredResume || "No resume on file — write a strong template the candidate can personalise."}

JOB POSTING:
Role: ${job.title || ""}
Company: ${job.company || ""}
${job.description ? `Description:\n${job.description}` : ""}`,
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    await jobDoc.ref.update({
      coverLetter:   text,
      coverLetterAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ text });
  } catch (err) {
    console.error("cover-letter error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/jobs/:jobId/interview-prep", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await enforceFeatureLimit(userId, "interview_preps");
    const { jobDoc, job, resume } = await getJobAndResume(req.params.jobId, userId);

    const response = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: `Prepare me for my interview at ${job.company || "this company"} for the ${job.title || "role"} position.

1. TECHNICAL QUESTIONS (6â€"8) — specific to the tech stack and skills in the job description. For each, include a short note on how to approach the answer.

2. BEHAVIORAL / SITUATIONAL QUESTIONS (5) — STAR method, tailored to what this role values.

3. QUESTIONS TO ASK THE INTERVIEWER (4) — thoughtful questions showing genuine interest.

${resume ? `CANDIDATE BACKGROUND:\n${resume.slice(0, 1500)}` : ""}

JOB DESCRIPTION:
${job.description || ""}`,
      }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    await jobDoc.ref.update({
      interviewPrep:   text,
      interviewPrepAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ text });
  } catch (err) {
    console.error("interview-prep error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/jobs/:jobId/network", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await enforceFeatureLimit(userId, "networking");
    const [jobDoc, kbDoc] = await Promise.all([
      db.collection("users").doc(userId).collection("jobs").doc(req.params.jobId).get(),
      db.collection("users").doc(userId).collection("knowledge").doc("profile").get(),
    ]);
    if (!jobDoc.exists) throw new Error("Job not found");
    const job = { id: jobDoc.id, ...jobDoc.data() };
    const kb  = kbDoc.exists ? kbDoc.data() : {};

    const backgroundParts = [
      kb.currentPosition && `Current: ${kb.currentPosition}`,
      kb.previousPositions && `Previous: ${kb.previousPositions}`,
      kb.education && `Education: ${kb.education}`,
      kb.skills && `Skills: ${kb.skills}`,
    ].filter(Boolean);
    const background = backgroundParts.join(" | ") || (kb.resume ? kb.resume.slice(0, 600) : "");

    const response = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 3000,
      tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      messages: [{
        role:    "user",
        content: `You are a networking strategist helping a job seeker strategically contact the right people at ${job.company || "the target company"} for a ${job.title || "role"} position.

Use web search to find real people at this company:
1. Search for recruiters or talent acquisition staff at ${job.company}
2. Search for engineering managers, team leads, or hiring staff relevant to "${job.title}" at ${job.company}

CANDIDATE BACKGROUND:
${background || "Not provided"}

JOB:
Role: ${job.title || ""}
Company: ${job.company || ""}
Location: ${job.location || ""}
${job.description ? `Description:\n${job.description.slice(0, 600)}` : ""}

Based on your research, identify the 5 most strategic people for this candidate to contact. For each, write a personalized LinkedIn message (under 120 words) that:
- Opens with a specific genuine hook (shared background, their work, or role context)
- Does NOT say "I'm applying" — frames the outreach as seeking advice or insight
- Ends with a single soft ask (brief call, insight, or introduction)
- Feels human and specific, NOT like a template

Respond with ONLY a valid JSON object, no text before or after:
{
  "contacts": [
    {
      "name": "Full Name",
      "title": "Their exact verified job title from search results -- never guess or infer",
      "linkedinSearch": "only the person's full name, nothing else (used for LinkedIn people search)",
      "type": "recruiter|hiring_manager|team_member|alumni|peer",
      "score": 85,
      "why": "2-sentence explanation of why contacting this person is valuable",
      "sharedSignals": ["signal 1", "signal 2"],
      "messageDraft": "Hi [Name], ..."
    }
  ],
  "strategy": "2-3 sentence recommended outreach strategy and order"
}`,
      }],
    });

    const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    let networking;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      networking = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      throw new Error("Could not parse networking results — please try again.");
    }

    await jobDoc.ref.update({
      networkingContacts: networking.contacts || [],
      networkingStrategy: networking.strategy || "",
      networkingAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json(networking);
  } catch (err) {
    console.error("network error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.userId).collection("jobs").get();
    const jobs = sortByDate(snap.docs).slice(0, 50).map(d => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

// â"€â"€ Manual search now â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.post("/search/now/:userId", async (req, res) => {
  const { userId } = req.params;
  let logRef = null;
  const logMessages = [];
  try {
    const [prefDoc, tier, userDoc] = await Promise.all([
      db.collection("users").doc(userId).collection("preferences").doc("config").get(),
      getUserTier(userId),
      db.collection("users").doc(userId).get(),
    ]);
    if (!prefDoc.exists) {
      return res.status(400).json({ error: "No preferences saved yet. Please set your preferences first." });
    }
    await ensureUser(userId);
    const role = userDoc.exists ? (userDoc.data().role || "customer") : "customer";
    if (role !== "admin") {
      await enforceFeatureLimit(userId, "searches_manual");
    }

    let logFn = null;
    if (role === "admin") {
      logRef = db.collection("search_logs").doc(userId);
      await logRef.set({ startedAt: admin.firestore.FieldValue.serverTimestamp(), status: "running", log: [] });
      logFn = async (msg) => {
        const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
        logMessages.push(`${ts}  ${msg}`);
        await logRef.update({ log: logMessages, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      };
    }

    const prefs = prefDoc.data();
    const jobs  = await runJobSearch(userId, prefs, tier, logFn);

    if (logRef) {
      await logRef.update({ status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    res.json({ ok: true, jobCount: jobs.length, tier });
  } catch (err) {
    console.error("Search now error:", err.message, err.stack);
    if (logRef) {
      logRef.update({ status: "failed", error: err.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    res.status(500).json({ error: err.message || "Search failed. Please try again." });
  }
});

// ── Admin search log polling ───────────────────────────────────────────────────
// Frontend polls this every 2s instead of using Firestore onSnapshot directly,
// avoiding client-side auth/rules issues entirely.
app.get("/search/logs/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists || userDoc.data().role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const logDoc = await db.collection("search_logs").doc(userId).get();
    if (!logDoc.exists) return res.json({ status: "none", log: [] });
    res.json(logDoc.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â"€â"€ User / tier management â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    await ensureUser(userId);
    const doc        = await db.collection("users").doc(userId).get();
    const data       = doc.exists ? doc.data() : {};
    const tier       = data.tier || "free";
    const role       = data.role || "customer";
    const tierConfig = TIERS[tier] || TIERS.free;
    res.json({ tier, tierConfig, role });
  } catch (err) {
    res.status(500).json({ error: "Failed to load user" });
  }
});

// Admin / Stripe-webhook endpoint — sets a user's tier.
// Protect this with a shared secret before exposing to the internet.
// When integrating Stripe: call this from your webhook handler after
// a checkout.session.completed or customer.subscription.updated event.

// -- Admin stats endpoint (role must equal "admin" in Firestore users doc) --
app.get("/admin/stats/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists || userDoc.data().role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now         = Date.now();
    const cutoff24h   = now - 24 * 60 * 60 * 1000;
    const cutoffWeek  = now -  7 * 24 * 60 * 60 * 1000;
    const cutoffMonth = now - 30 * 24 * 60 * 60 * 1000;

    const [usersSnap, activitySnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("platform_events").get(),
    ]);

    const users         = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const freeTierCount = users.filter(u => (u.tier || "free") === "free").length;
    const proTierCount  = users.filter(u => u.tier === "pro").length;
    const activity      = activitySnap.docs.map(d => d.data());

    const computeSpend = (cutoff) => {
      const byUser = {};
      for (const a of activity) {
        if ((a.createdAt?.toMillis?.() || 0) <= cutoff) continue;
        if (!byUser[a.userId]) byUser[a.userId] = { cost: 0, runs: 0 };
        byUser[a.userId].cost += a.cost || 0;
        byUser[a.userId].runs += 1;
      }
      return { total: Object.values(byUser).reduce((s, u) => s + u.cost, 0), byUser };
    };

    const stats24h   = computeSpend(cutoff24h);
    const statsWeek  = computeSpend(cutoffWeek);
    const statsMonth = computeSpend(cutoffMonth);

    const activeUserIds = new Set(
      activity.filter(a => (a.createdAt?.toMillis?.() || 0) > cutoffWeek).map(a => a.userId)
    );

    const activityCountMonth = {};
    activity
      .filter(a => (a.createdAt?.toMillis?.() || 0) > cutoffMonth)
      .forEach(a => { activityCountMonth[a.userId] = (activityCountMonth[a.userId] || 0) + 1; });

    const mostActiveUsers = Object.entries(activityCountMonth)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([uid, count]) => {
        const u = users.find(x => x.id === uid) || {};
        return { userId: uid, count, tier: u.tier || "free", spending30d: statsMonth.byUser[uid]?.cost || 0 };
      });

    const inactivePaidUsers = users
      .filter(u => u.tier === "pro" && !activeUserIds.has(u.id))
      .slice(0, 20)
      .map(u => ({ userId: u.id, tier: "pro" }));

    const inactiveFreeUsers = users
      .filter(u => (u.tier || "free") === "free" && !activeUserIds.has(u.id))
      .slice(0, 20)
      .map(u => ({ userId: u.id, tier: "free" }));

    res.json({
      totalUsers: users.length,
      freeTierCount,
      proTierCount,
      activeUsersWeek: activeUserIds.size,
      spending: { "24h": stats24h.total, week: statsWeek.total, month: statsMonth.total },
      mostActiveUsers,
      inactivePaidUsers,
      inactiveFreeUsers,
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ error: "Failed to load admin stats" });
  }
});
app.post("/user/tier", async (req, res) => {
  const { userId, tier, secret } = req.body;
  if (!userId || !tier) return res.status(400).json({ error: "userId and tier required" });
  if (!["free", "pro"].includes(tier)) return res.status(400).json({ error: "Invalid tier" });
  // Simple shared-secret guard — set ADMIN_SECRET in your Cloud Functions env vars
  // to protect this endpoint until you have real Stripe auth in place.
  if (process.env.ADMIN_SECRET && secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await db.collection("users").doc(userId).set(
      { tier, tierUpdatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ ok: true, tier });
  } catch (err) {
    res.status(500).json({ error: "Failed to update tier" });
  }
});

// â"€â"€ Stripe Checkout â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.post("/create-checkout-session", async (req, res) => {
  const { userId, userEmail, billingPeriod } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  // STRIPE_PRO_MONTHLY_PRICE_ID takes precedence; falls back to STRIPE_PRO_PRICE_ID for existing deployments
  const priceId = billingPeriod === "annual"
    ? process.env.STRIPE_PRO_ANNUAL_PRICE_ID
    : (process.env.STRIPE_PRO_MONTHLY_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID);
  if (!priceId) return res.status(500).json({ error: "Stripe price not configured" });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer_email: userEmail || undefined,
      subscription_data: { trial_period_days: 7 },
      success_url: `${SITE_URL}/dashboard.html?subscription=success`,
      cancel_url:  `${SITE_URL}/dashboard.html?subscription=canceled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-portal-session", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;
    if (!customerId) return res.status(404).json({ error: "No Stripe customer found for this user" });

    const stripe  = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${SITE_URL}/dashboard.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe portal error:", err);
    res.status(500).json({ error: err.message });
  }
});

// â"€â"€ Push Notification token management â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.post("/notifications/token", async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).json({ error: "userId and token required" });
  try {
    const ref = db.collection("fcmTokens").doc(userId);
    await ref.set(
      { tokens: admin.firestore.FieldValue.arrayUnion(token), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save token" });
  }
});

// â"€â"€ Target Companies (Watchlist) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
app.get("/target-companies/:userId", async (req, res) => {
  try {
    const doc = await db.collection("targetCompanies").doc(req.params.userId).get();
    res.json(doc.exists ? doc.data() : { companies: [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to load target companies" });
  }
});

app.post("/target-companies/save", async (req, res) => {
  const { userId, companies } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  if (!Array.isArray(companies)) return res.status(400).json({ error: "companies must be an array" });
  try {
    await db.collection("targetCompanies").doc(userId).set({
      companies: companies.filter(c => c.name).map(c => ({
        name: c.name.trim(),
        url:  (c.url || "").trim(),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save target companies" });
  }
});

app.get("/watchlist-jobs/:userId/detail/:jobId", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.userId).collection("watchlistJobs").doc(req.params.jobId).get();
    if (!doc.exists) return res.status(404).json({ error: "Job not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load watchlist job" });
  }
});

app.get("/watchlist-jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.userId).collection("watchlistJobs").get();
    const jobs = sortByDate(snap.docs).slice(0, 100).map(d => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load watchlist jobs" });
  }
});

exports.api = functions
  .runWith({
    timeoutSeconds: 540,
    secrets: ["ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
              "STRIPE_PRO_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID"],
  })
  .https.onRequest(app);

// â"€â"€ Push notification sender â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function sendPushNotification(userId, title, body) {
  try {
    const doc = await db.collection("fcmTokens").doc(userId).get();
    if (!doc.exists) return;
    const tokens = doc.data().tokens || [];
    if (tokens.length === 0) return;

    const deadTokens = [];
    for (const token of tokens) {
      try {
        await admin.messaging().send({
          token,
          notification: { title, body },
          webpush: {
            notification: { icon: `${SITE_URL}/favicon.ico` },
            fcmOptions:   { link: `${SITE_URL}/dashboard.html` },
          },
        });
      } catch (err) {
        // Stale tokens (uninstalled app, revoked permission) should be pruned
        if (err.code === "messaging/registration-token-not-registered" ||
            err.code === "messaging/invalid-registration-token") {
          deadTokens.push(token);
        }
      }
    }

    if (deadTokens.length > 0) {
      await db.collection("fcmTokens").doc(userId).update({
        tokens: admin.firestore.FieldValue.arrayRemove(...deadTokens),
      });
    }
  } catch (err) {
    console.error(`sendPushNotification failed for ${userId}:`, err.message);
  }
}

// â"€â"€ Watchlist helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function makeWatchlistFingerprint(company, title, url) {
  const jobId = extractJobId(url);
  if (jobId) return jobId;
  const co = (company || "").toLowerCase().replace(/\s+/g, " ").trim();
  const ti = (title   || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${co}::${ti}`;
}

async function checkTargetCompany(userId, company) {
  // Get fingerprints of jobs already seen for this company
  const seenSnap = await db.collection("users").doc(userId).collection("watchlistJobs")
    .where("company", "==", company.name)
    .get();
  const seenFingerprints = new Set(
    seenSnap.docs.map(d => d.data().fingerprint).filter(Boolean)
  );

  // Resolve career page URL via web search if not stored
  let careerPageUrl = company.url || "";
  if (!careerPageUrl) {
    try {
      const urlRes = await anthropic.messages.create({
        model:      MODEL_SONNET,
        max_tokens: 256,
        tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        messages:   [{ role: "user", content: `Find the official careers or jobs page URL for "${company.name}". Return ONLY a JSON object, no explanation: {"url":"https://..."}` }],
      });
      const urlRaw  = urlRes.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
      const urlMatch = urlRaw.match(/\{[\s\S]*\}/);
      if (urlMatch) {
        const resolved = JSON.parse(urlMatch[0]).url || "";
        if (resolved.startsWith("http")) {
          careerPageUrl = resolved;
          // Persist resolved URL so future checks skip this lookup
          const docRef = db.collection("targetCompanies").doc(userId);
          const snap   = await docRef.get();
          if (snap.exists) {
            const updated = (snap.data().companies || []).map(c =>
              c.name === company.name ? { ...c, url: careerPageUrl } : c
            );
            await docRef.update({ companies: updated });
          }
        }
      }
    } catch (err) {
      console.warn(`Could not resolve career page for ${company.name}:`, err.message);
    }
  }

  const systemPrompt = `You are a job search agent monitoring a specific company's career page. Visit the URL provided and list all currently open positions.

Return ONLY a raw JSON array — no markdown, no explanation:
[{"title":"","location":"","url":"","salary":"","description":"","posted":""}]

Rules:
- url: copy the DIRECT job posting URL verbatim from the page â€" it must link to THIS specific listing, not the company's generic careers page. Do NOT construct or guess URLs. If no direct posting link is visible, use "" (empty string).
- description: 2-4 sentences describing the role and key requirements.
- Return up to 25 jobs; if more exist, prioritise the most recently posted.
- Return [] if the page is inaccessible or has no open positions.`;

  let jobs = [];
  try {
    const response = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 3000,
      tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      system:     systemPrompt,
      messages:   [{ role: "user", content: `Find all open jobs at ${company.name}. Career page: ${careerPageUrl || company.name + " careers"}` }],
    });

    const raw = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")
      .trim();

    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) jobs = JSON.parse(match[0]);
  } catch (err) {
    console.error(`Watchlist check failed for ${company.name}:`, err.message);
    return 0;
  }

  // Keep only jobs not seen before
  const newJobs = jobs.filter(job => {
    if (!job.title) return false;
    const fp = makeWatchlistFingerprint(company.name, job.title, job.url);
    return !seenFingerprints.has(fp);
  });

  if (newJobs.length > 0) {
    const saves = newJobs.map(job => {
      const fp = makeWatchlistFingerprint(company.name, job.title, job.url);
      return db.collection("users").doc(userId).collection("watchlistJobs").add({
        userId,
        company:    company.name,
        companyUrl: company.url,
        title:       job.title       || "",
        location:    job.location    || "",
        salary:      job.salary      || "",
        description: job.description || "",
        url:         job.url         || company.url,
        posted:      job.posted      || "",
        fingerprint: fp,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await Promise.all(saves);

    // Notify the user about new openings at their target company
    const notifTitle = newJobs.length === 1
      ? `New job at ${company.name}`
      : `${newJobs.length} new jobs at ${company.name}`;
    const notifBody = newJobs.slice(0, 2).map(j => j.title).join(" Â· ");
    sendPushNotification(userId, notifTitle, notifBody).catch(() => {});
  }

  return newJobs.length;
}

// â"€â"€ Schedule helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function getLocalHour(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(date);
    return parseInt(parts.find(p => p.type === "hour").value, 10) % 24;
  } catch {
    return date.getUTCHours(); // fallback if timezone is invalid
  }
}

function computeSearchHours(prefs) {
  const startHour   = prefs.searchStartHour   ?? 8;
  const timesPerDay = Math.min(4, Math.max(1, prefs.searchTimesPerDay ?? 1));
  const interval    = Math.floor(24 / timesPerDay);
  const hours = [];
  for (let i = 0; i < timesPerDay; i++) {
    hours.push((startHour + i * interval) % 24);
  }
  return hours;
}

// â"€â"€ Job search — runs every hour, fires per each user's schedule â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
exports.dailyJobSearch = onSchedule(
  { schedule: "0 * * * *", timeZone: "UTC" },
  async () => {
    try {
      const now       = new Date();
      // Collection-group query across all users/{userId}/preferences/config docs
      const prefsSnap = await db.collectionGroup("preferences").get();
      if (prefsSnap.empty) return;

      for (const doc of prefsSnap.docs) {
        if (doc.id !== "config") continue; // only process config docs
        const userId = doc.ref.parent.parent.id; // users/{userId}/preferences/config
        const prefs  = doc.data();

        // Skip if user has turned off automated search
        if (prefs.searchEnabled === false) continue;

        // Fetch user tier and clamp searches/day to tier limit
        const tier       = await getUserTier(userId);
        const tierConfig = TIERS[tier] || TIERS.free;
        const cappedPrefs = {
          ...prefs,
          searchTimesPerDay: Math.min(
            prefs.searchTimesPerDay ?? 1,
            tierConfig.maxSearchesPerDay
          ),
        };

        // Check if the current local hour matches any of this user's search hours
        const tz        = prefs.notifTimezone || "America/Los_Angeles";
        const localHour = getLocalHour(now, tz);
        const searchHrs = computeSearchHours(cappedPrefs);
        if (!searchHrs.includes(localHour)) continue;

        try {
          await runJobSearch(userId, prefs, tier);
          console.log(`Job search completed for ${userId} (tier: ${tier})`);
        } catch (err) {
          console.error(`Search failed for ${userId}:`, err.message);
        }
      }
    } catch (err) {
      console.error("Daily job search error:", err.message);
    }
  }
);

// â"€â"€ Daily watchlist check — 9am Pacific â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

// -- Account deletion trigger: wipe ALL user data when a Firebase Auth account is deleted --------
// Fires automatically whether the account is deleted from the Firebase console,
// the app UI, or anywhere else.
exports.onUserDeleted = functions.auth.user().onDelete(async (user) => {
  const email = user.email;
  const uid   = user.uid;

  if (!email) return; // anonymous / phone-only accounts -- nothing keyed by email

  console.log('[onUserDeleted] Starting full data wipe for ' + email + ' (' + uid + ')');

  // Helper: batch-delete every document returned by a query, 400 at a time.
  async function deleteQuery(query) {
    const snap = await query.get();
    if (snap.empty) return;
    let batch = db.batch();
    let count = 0;
    const commits = [];
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      if (++count === 400) {
        commits.push(batch.commit());
        batch = db.batch();
        count = 0;
      }
    }
    if (count > 0) commits.push(batch.commit());
    await Promise.all(commits);
  }

  await Promise.all([
    // 1. UID-keyed subtree (onboarding/state, and any future UID-keyed data).
    admin.firestore().recursiveDelete(db.collection("users").doc(uid)),

    // 2. Email-keyed user subtree: preferences, knowledge, usage, jobs,
    //    documents, applications, watchlistJobs -- all now subcollections.
    //    recursiveDelete handles the entire tree in one call.
    admin.firestore().recursiveDelete(db.collection("users").doc(email)),

    // 3. Flat top-level docs keyed by email.
    db.collection("fcmTokens")      .doc(email).delete(),
    db.collection("targetCompanies").doc(email).delete(),
    db.collection("chats")          .doc(email).delete(),

    // 4. Field-keyed collections not yet migrated to subcollections.
    deleteQuery(db.collection("digests")        .where("userId", "==", email)),
    deleteQuery(db.collection("platform_events").where("userId", "==", email)),
    deleteQuery(db.collection("chats")          .where("userId", "==", email)),
  ]);

  console.log('[onUserDeleted] Wipe complete for ' + uid);
});

// ── Weekly jobs_cache cleanup ─────────────────────────────────────────────────────
exports.weeklyJobCacheCleanup = onSchedule(
  { schedule: "0 2 * * 0", timeZone: "UTC" },
  async () => {
    try {
      const staleSnap = await db.collection("jobs_cache")
        .where("expiresAt", "<", new Date())
        .limit(500)
        .get();
      if (staleSnap.empty) {
        console.log("[weeklyJobCacheCleanup] No stale entries found");
        return;
      }
      let batch = db.batch();
      let count = 0;
      for (const doc of staleSnap.docs) {
        batch.delete(doc.ref);
        if (++count === 400) { await batch.commit(); batch = db.batch(); count = 0; }
      }
      if (count > 0) await batch.commit();
      console.log("[weeklyJobCacheCleanup] Deleted " + staleSnap.size + " stale cache entries");
    } catch (err) {
      console.error("[weeklyJobCacheCleanup] Error:", err.message);
    }
  }
);

// â"€â"€ Nightly URL revalidation â€" detects expired / redirected job URLs â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Checks up to 200 jobs per run, prioritising those not validated in 3+ days.
// Marks expired links (404/410), follows permanent redirects to update URLs.
// Requires a Firestore composite index: collection-group "jobs", field "createdAt" ASC.
exports.revalidateJobUrls = onSchedule(
  { schedule: "0 4 * * *", timeZone: "UTC", timeoutSeconds: 300 },
  async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const threeDaysAgo  = new Date(Date.now() -  3 * 24 * 60 * 60 * 1000);

    let snap;
    try {
      snap = await db.collectionGroup("jobs")
        .where("createdAt", ">", thirtyDaysAgo)
        .limit(200)
        .get();
    } catch (err) {
      // Collection-group query requires an index — log and skip gracefully
      console.warn("[revalidate] Index may be missing:", err.message);
      return;
    }

    let checked = 0, expired = 0, updated = 0;
    for (const doc of snap.docs) {
      const job       = doc.data();
      const validated = job.urlLastValidated?.toDate?.();
      if (validated && validated > threeDaysAgo) continue; // recently checked

      const urlToCheck = job.directUrl || job.url;
      if (!urlToCheck?.startsWith("http")) continue;

      try {
        const result = await fetchUrlStatus(urlToCheck);
        const patch  = { urlLastValidated: admin.firestore.FieldValue.serverTimestamp() };

        if (result.status === 404 || result.status === 410) {
          patch.urlExpired = true;
          patch.directUrl  = "";
          expired++;
        } else if (result.status === 200 && result.finalUrl !== urlToCheck) {
          patch.directUrl  = result.finalUrl; // permanent redirect â€" update
          patch.urlExpired = false;
          updated++;
        } else if (result.status === 200) {
          patch.urlExpired = false;
        }

        await doc.ref.update(patch);
        checked++;
      } catch (err) {
        console.warn(`[revalidate] ${job.title} @ ${job.company}: ${err.message}`);
      }
    }
    console.log(`[revalidate] checked=${checked} expired=${expired} redirects_updated=${updated}`);
  }
);

exports.dailyWatchlistCheck = onSchedule(
  { schedule: "0 9 * * *", timeZone: "America/Los_Angeles" },
  async () => {
    try {
      const snap = await db.collection("targetCompanies").get();
      if (snap.empty) return;
      for (const doc of snap.docs) {
        const userId    = doc.id;
        const companies = doc.data().companies || [];
        for (const company of companies) {
          if (!company.name) continue;
          try {
            const count = await checkTargetCompany(userId, company);
            console.log(`Watchlist: ${count} new jobs at ${company.name} for ${userId}`);
          } catch (err) {
            console.error(`Watchlist failed for ${company.name} (${userId}):`, err.message);
          }
        }
      }
    } catch (err) {
      console.error("Daily watchlist check error:", err.message);
    }
  }
);
