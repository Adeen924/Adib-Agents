const functions = require("firebase-functions/v1");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");
const Stripe    = require("stripe");

admin.initializeApp();

// Live site URL â€” used as the click-through destination in push notifications.
// Update this if you move to a custom domain.
const SITE_URL = "https://adeen924.github.io/Adib-Agents";

const app = express();
app.use(cors({ origin: true }));

// â”€â”€ Stripe webhook â€” must be registered BEFORE express.json() so we get the raw body â”€â”€
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

// Claude Sonnet 4.6 â€” complex reasoning, writing, web synthesis
const INPUT_COST_SONNET  = 3    / 1_000_000;
const OUTPUT_COST_SONNET = 15   / 1_000_000;
// Claude Haiku 4.5 â€” structured extraction and templated generation (~3.75Ã— cheaper)
const INPUT_COST_HAIKU   = 0.80 / 1_000_000;
const OUTPUT_COST_HAIKU  = 4    / 1_000_000;
// Legacy aliases
const INPUT_COST  = INPUT_COST_SONNET;
const OUTPUT_COST = OUTPUT_COST_SONNET;

const MODEL_SONNET = "claude-sonnet-4-6";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";

// â”€â”€ Subscription tiers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Enforce these limits in runJobSearch and the scheduler.
// When Stripe is wired up, the webhook sets tier in the `users` collection.
const TIERS = {
  free: {
    label:               "Free",
    maxSearchesPerDay:   1,
    webSearchesPerQuery: 1,
    maxOutputTokens:     4000,
    customSites:         false,
    maxTargetCompanies:  3,
    jobsPerSearch:       5,
    manualSearch:        false, // scheduled only â€” no Search Now button
  },
  pro: {
    label:               "Pro",
    maxSearchesPerDay:   4,
    webSearchesPerQuery: 3,
    maxOutputTokens:     4000,
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
    await ref.set({ tier: "free", email: userId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

// â”€â”€ Feature usage limits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  const ref = db.collection("featureUsage").doc(`${userId}_${windowKey}`);

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
      { [feature]: current + 1, userId, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  });
}


// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const builtIn = ["LinkedIn", "Indeed", "Greenhouse", "Lever", "Wellfound", "Builtin"];
  const custom  = tierConfig.customSites
    ? (prefs.customSites || "").split(",").map(s => s.trim()).filter(Boolean)
    : [];
  return [...custom, ...builtIn].join(", ");
}

// Run a job search for one user â€” limits are tier-based
async function runJobSearch(userId, prefs, tier = "free") {
  const tierConfig = TIERS[tier] || TIERS.free;

  const query     = buildSearchQuery(prefs);
  const jobBoards = buildJobBoardsContext(prefs, tierConfig);

  // Fetch full knowledge base for multi-dimensional matching
  let resumeSnippet = "";
  let candidateProfile = "";
  try {
    const kbDoc = await db.collection("knowledge").doc(userId).get();
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
    const recentSnap = await db.collection("jobs").where("userId", "==", userId).get();
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
    ? `\nAlready found this week â€” skip these, find different ones:\n${
        recentJobs.slice(0, 20).map(j => `- ${j.company}: ${j.title}`).join("\n")
      }\n`
    : "";

  const jobCount = tierConfig.jobsPerSearch || 5;

  const systemPrompt = `You are an intelligent job matching agent. Search job boards, find real current postings, and evaluate each one across multiple dimensions to surface the best matches for this specific candidate.

${candidateProfile ? `CANDIDATE PROFILE:\n${candidateProfile}\n` : ""}
REQUIRED CRITERIA (hard filters â€” reject any job that does not match ALL of these):
${criteria || "No specific criteria."}
${seenSection}
MATCHING DIMENSIONS â€” score and reason across all of these for every job you return:
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

Rules:
- Only include direct job posting URLs (not search pages or Google results)
- Prefer postings from the last 14 days
- Skip jobs where the required experience is significantly above the candidate's level

Return exactly ${jobCount} jobs as a raw JSON array â€” no markdown, no explanation, nothing else.
Field rules:
- fitScore: integer 0-100 reflecting overall match quality across all 10 dimensions (not keyword count)
- matchReasons: array of 3-5 short strings (1-2 sentences each) explaining WHY this job fits the candidate â€” reference specific dimensions and the candidate's actual background
- url: CRITICAL â€” only include a URL found verbatim in your search results. Do NOT construct or guess URLs. Use "" if you cannot confirm the exact direct link.
- posted: exact date as "Month DD, YYYY" (e.g. "May 10, 2026") or relative like "2 days ago". Never just a year. Use "" if unknown.
- description: full job details â€” role responsibilities, required skills, nice-to-haves, team context. Aim for 6-8 sentences minimum.

[{"title":"","company":"","location":"","salary":"","experience":"","description":"","url":"","posted":"","fitScore":85,"matchReasons":["Experience Depth: ...","Transferable Skills: ...","Project Similarity: ..."]}]`;

  const userQuery = `Find ${jobCount} job listings matching: ${query}`;

  const response = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: Math.max(tierConfig.maxOutputTokens, 2500),
    tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: tierConfig.webSearchesPerQuery }],
    system:     systemPrompt,
    messages:   [{ role: "user", content: userQuery }],
  });

  const raw = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n\n")
    .trim();

  // Parse JSON â€” strip code fences if present
  let jobs = [];
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) jobs = JSON.parse(match[0]);
    if (jobs.length === 0) {
      console.warn(`[runJobSearch] Parsed 0 jobs for ${userId}. stop_reason=${response.stop_reason} raw_preview=${raw.slice(0, 400)}`);
    }
  } catch (e) {
    console.error(`[runJobSearch] JSON parse failed for ${userId}: ${e.message} | raw_preview=${raw.slice(0, 400)}`);
    jobs = [];
  }

  // Server-side deduplication: remove jobs already found this week
  const uniqueJobs = jobs.filter(job => {
    if (!job.title && !job.company) return false;
    const fp = makeJobFingerprint(job);
    if (seenFingerprints.has(fp)) return false;
    seenFingerprints.add(fp); // also dedupe within this batch
    return true;
  });

  // Save search summary to digests
  const digestRef = await db.collection("digests").add({
    userId, query,
    jobCount:  uniqueJobs.length,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Save each new job as an individual document
  const savePromises = uniqueJobs.map(job =>
    db.collection("jobs").add({
      userId,
      digestId: digestRef.id,
      title:        job.title        || "",
      company:      job.company      || "",
      location:     job.location     || "",
      salary:       job.salary       || "",
      experience:   job.experience   || "",
      description:  job.description  || "",
      url:          job.url          || "",
      posted:       job.posted       || "",
      fitScore:     typeof job.fitScore === "number" ? job.fitScore : null,
      matchReasons: Array.isArray(job.matchReasons) ? job.matchReasons : [],
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    })
  );
  await Promise.all(savePromises);

  // Send push notification if new jobs were found
  if (uniqueJobs.length > 0) {
    const preview = uniqueJobs.slice(0, 2).map(j => `${j.title} at ${j.company}`).join(" Â· ");
    const notifTitle = uniqueJobs.length === 1
      ? "1 new job found"
      : `${uniqueJobs.length} new jobs found`;
    sendPushNotification(userId, notifTitle, preview).catch(() => {});
  }

  // Track cost using Sonnet rates
  if (response.usage) {
    const { input_tokens, output_tokens } = response.usage;
    await db.collection("activity").add({
      userId, view: "job_search",
      inputTokens:  input_tokens,
      outputTokens: output_tokens,
      cost: (input_tokens * INPUT_COST_SONNET) + (output_tokens * OUTPUT_COST_SONNET),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return uniqueJobs;
}

// â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/", (req, res) => res.send("Backend is running"));

// â”€â”€ Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/stats/:userId", async (req, res) => {
  try {
    const snap   = await db.collection("activity").where("userId", "==", req.params.userId).get();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = snap.docs.filter((d) => (d.data().createdAt?.toMillis?.() || 0) > cutoff);

    const totals = recent.reduce(
      (acc, d) => {
        const data = d.data();
        acc.runs++;
        acc.inputTokens  += data.inputTokens  || 0;
        acc.outputTokens += data.outputTokens || 0;
        acc.cost         += data.cost         || 0;
        return acc;
      },
      { runs: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    );

    res.json({
      ...totals,
      totalTokens:   totals.inputTokens + totals.outputTokens,
      costFormatted: `$${totals.cost.toFixed(4)}`,
    });
  } catch (err) {
    console.error("Stats error:", err.message);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// â”€â”€ Documents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/documents/:userId/:type", async (req, res) => {
  const { userId, type } = req.params;
  try {
    const snap = await db.collection("documents").where("userId", "==", userId).get();
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
    const ref = await db.collection("documents").add({
      userId, type, content,
      title:   title   || (type === "resume" ? "Resume" : "Cover Letter"),
      company: company || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, id: ref.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to save document" });
  }
});

app.delete("/documents/:docId", async (req, res) => {
  try {
    await db.collection("documents").doc(req.params.docId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// â”€â”€ Applications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/applications/:userId", async (req, res) => {
  try {
    const snap = await db.collection("applications").where("userId", "==", req.params.userId).get();
    const applications = sortByDate(snap.docs).map(d => ({ id: d.id, ...d.data() }));
    res.json({ applications });
  } catch (err) {
    res.status(500).json({ error: "Failed to load applications" });
  }
});

app.post("/applications/save", async (req, res) => {
  const { userId, id, company, role, status, url, notes, appliedAt } = req.body;
  if (!userId || !company || !role)
    return res.status(400).json({ error: "userId, company, and role are required" });
  try {
    const data = {
      userId, company, role,
      status:    status    || "Applied",
      url:       url       || "",
      notes:     notes     || "",
      appliedAt: appliedAt || new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (id) {
      await db.collection("applications").doc(id).set(data, { merge: true });
      res.json({ ok: true, id });
    } else {
      data.createdAt = admin.firestore.FieldValue.serverTimestamp();
      const ref = await db.collection("applications").add(data);
      res.json({ ok: true, id: ref.id });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to save application" });
  }
});

app.delete("/applications/:appId", async (req, res) => {
  try {
    await db.collection("applications").doc(req.params.appId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete application" });
  }
});

// â”€â”€ Knowledge Base â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/knowledge/:userId", async (req, res) => {
  try {
    const doc = await db.collection("knowledge").doc(req.params.userId).get();
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
    await db.collection("knowledge").doc(userId).set({
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

// â”€â”€ Preferences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/preferences/:userId", async (req, res) => {
  try {
    const doc = await db.collection("preferences").doc(req.params.userId).get();
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
    await db.collection("preferences").doc(userId).set(update, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// â”€â”€ Parse resume â†’ structured fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/knowledge/parse-resume", async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText || !resumeText.trim())
    return res.status(400).json({ error: "resumeText is required" });

  try {
    const response = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 1024,
      messages: [{
        role:    "user",
        content: `You are a resume parser. Extract structured information from the resume below and return ONLY a valid JSON object â€” no explanation, no markdown, no code fences, just the raw JSON.

Use these exact fields (use empty string "" for anything not found):
{
  "currentPosition": "Most recent job title and company with dates, e.g. Senior Engineer at Acme Corp (2022â€“present)",
  "previousPositions": "All previous roles, one per line, e.g.\\nSoftware Engineer at Startup Inc (2019â€“2022)\\nJunior Developer at Agency (2017â€“2019)",
  "targetRole": "The next logical role for this candidate based on their trajectory, e.g. Staff Engineer or Head of Product",
  "skills": "Comma-separated list of all technical skills, tools, languages, and frameworks found",
  "education": "Degree, institution, and graduation year, e.g. BS Computer Science, University of Washington (2017)",
  "additionalContext": "Notable projects, certifications, publications, awards, or anything else that stands out"
}

Resume:
${resumeText.slice(0, 8000)}`,
      }],
    });

    const raw = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    // Strip markdown code fences if Claude adds them despite instructions
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (err) {
    console.error("Parse resume error:", err.message);
    res.status(500).json({ error: "Failed to parse resume" });
  }
});

// â”€â”€ Digest â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/digest/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests").where("userId", "==", req.params.userId).get();
    const digests = sortByDate(snap.docs).slice(0, 10).map(d => ({ id: d.id, ...d.data() }));
    res.json({ digests });
  } catch (err) {
    res.status(500).json({ error: "Failed to load digest" });
  }
});

// â”€â”€ Jobs Found â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// IMPORTANT: /jobs/detail/:jobId must come before /jobs/:userId
app.get("/jobs/detail/:jobId", async (req, res) => {
  try {
    const doc = await db.collection("jobs").doc(req.params.jobId).get();
    if (!doc.exists) return res.status(404).json({ error: "Job not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load job" });
  }
});

// â”€â”€ Per-job AI document generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getJobAndResume(jobId, userId) {
  const [jobDoc, kbDoc] = await Promise.all([
    db.collection("jobs").doc(jobId).get(),
    db.collection("knowledge").doc(userId).get(),
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
      system: `You are an expert resume writer. Output plain text only â€” no markdown, no ** bold **, no _ italic _, no special symbols, no HTML.

Formatting rules (follow exactly â€” every rule matters for parsing):
- LINE 1: candidate's full name ONLY â€” nothing else on this line
- LINE 2: email | phone | location (LinkedIn URL if available) â€” contact info ONLY, nothing else
- LINE 3: blank line
- Section headers in ALL CAPS on their own line: PROFESSIONAL SUMMARY, EXPERIENCE, EDUCATION, SKILLS
- Each role on its own line: Job Title | Company Name | Month Year â€“ Month Year
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
${resume || "No resume on file â€” write a clean template with [PLACEHOLDER] for the candidate to fill in."}

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

Search the web for "${job.company || ""} mission values culture" to find genuine details about the company â€” reference them specifically in the letter.

Guidelines:
- 3â€“4 paragraphs, professional but warm tone
- Opening: name the specific role and a genuine reason for interest
- Body: connect 2â€“3 specific experiences from the candidate's resume to the role's requirements
- Company paragraph: reference real mission/values/products from your search
- Closing: clear call to action, no clichÃ©s

Output the letter only â€” no subject line, no "Here is your cover letter" preamble.

CANDIDATE'S RESUME:
${tailoredResume || "No resume on file â€” write a strong template the candidate can personalise."}

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

1. TECHNICAL QUESTIONS (6â€“8) â€” specific to the tech stack and skills in the job description. For each, include a short note on how to approach the answer.

2. BEHAVIORAL / SITUATIONAL QUESTIONS (5) â€” STAR method, tailored to what this role values.

3. QUESTIONS TO ASK THE INTERVIEWER (4) â€” thoughtful questions showing genuine interest.

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
      db.collection("jobs").doc(req.params.jobId).get(),
      db.collection("knowledge").doc(userId).get(),
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
- Does NOT say "I'm applying" â€” frames the outreach as seeking advice or insight
- Ends with a single soft ask (brief call, insight, or introduction)
- Feels human and specific, NOT like a template

Respond with ONLY a valid JSON object, no text before or after:
{
  "contacts": [
    {
      "name": "Full Name",
      "title": "Their Job Title",
      "linkedinSearch": "name company search query to find them",
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
      throw new Error("Could not parse networking results â€” please try again.");
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
    const snap = await db.collection("jobs").where("userId", "==", req.params.userId).get();
    const jobs = sortByDate(snap.docs).slice(0, 50).map(d => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

// â”€â”€ Manual search now â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/search/now/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const [prefDoc, tier] = await Promise.all([
      db.collection("preferences").doc(userId).get(),
      getUserTier(userId),
    ]);
    if (!prefDoc.exists) {
      return res.status(400).json({ error: "No preferences saved yet. Please set your preferences first." });
    }
    await ensureUser(userId);
    await enforceFeatureLimit(userId, "searches_manual");
    const prefs = prefDoc.data();
    const jobs = await runJobSearch(userId, prefs, tier);
    res.json({ ok: true, jobCount: jobs.length, tier });
  } catch (err) {
    console.error("Search now error:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Search failed. Please try again." });
  }
});

// â”€â”€ User / tier management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    await ensureUser(userId);
    const tier       = await getUserTier(userId);
    const tierConfig = TIERS[tier] || TIERS.free;
    res.json({ tier, tierConfig });
  } catch (err) {
    res.status(500).json({ error: "Failed to load user" });
  }
});

// Admin / Stripe-webhook endpoint â€” sets a user's tier.
// Protect this with a shared secret before exposing to the internet.
// When integrating Stripe: call this from your webhook handler after
// a checkout.session.completed or customer.subscription.updated event.
app.post("/user/tier", async (req, res) => {
  const { userId, tier, secret } = req.body;
  if (!userId || !tier) return res.status(400).json({ error: "userId and tier required" });
  if (!["free", "pro"].includes(tier)) return res.status(400).json({ error: "Invalid tier" });
  // Simple shared-secret guard â€” set ADMIN_SECRET in your Cloud Functions env vars
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

// â”€â”€ Stripe Checkout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Push Notification token management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Target Companies (Watchlist) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      companies: companies.filter(c => c.name && c.url).map(c => ({
        name: c.name.trim(),
        url:  c.url.trim(),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save target companies" });
  }
});

// IMPORTANT: /watchlist-jobs/detail/:jobId must come before /watchlist-jobs/:userId
app.get("/watchlist-jobs/detail/:jobId", async (req, res) => {
  try {
    const doc = await db.collection("watchlistJobs").doc(req.params.jobId).get();
    if (!doc.exists) return res.status(404).json({ error: "Job not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load watchlist job" });
  }
});

app.get("/watchlist-jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("watchlistJobs").where("userId", "==", req.params.userId).get();
    const jobs = sortByDate(snap.docs).slice(0, 100).map(d => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load watchlist jobs" });
  }
});

exports.api = functions
  .runWith({ secrets: ["ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID"] })
  .https.onRequest(app);

// â”€â”€ Push notification sender â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Watchlist helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function makeWatchlistFingerprint(company, title, url) {
  const jobId = extractJobId(url);
  if (jobId) return jobId;
  const co = (company || "").toLowerCase().replace(/\s+/g, " ").trim();
  const ti = (title   || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${co}::${ti}`;
}

async function checkTargetCompany(userId, company) {
  // Get fingerprints of jobs already seen for this company
  const seenSnap = await db.collection("watchlistJobs")
    .where("userId", "==", userId)
    .where("company", "==", company.name)
    .get();
  const seenFingerprints = new Set(
    seenSnap.docs.map(d => d.data().fingerprint).filter(Boolean)
  );

  const systemPrompt = `You are a job search agent monitoring a specific company's career page. Visit the URL provided and list all currently open positions.

Return ONLY a raw JSON array â€” no markdown, no explanation:
[{"title":"","location":"","url":"","salary":"","description":"","posted":""}]

Rules:
- url: copy the DIRECT job posting URL verbatim from the page. Do NOT construct or guess URLs. If no direct link is visible, use the career page URL.
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
      messages:   [{ role: "user", content: `Find all open jobs at ${company.name}. Career page: ${company.url}` }],
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
      return db.collection("watchlistJobs").add({
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

// â”€â”€ Schedule helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Job search â€” runs every hour, fires per each user's schedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.dailyJobSearch = onSchedule(
  { schedule: "0 * * * *", timeZone: "UTC" },
  async () => {
    try {
      const now       = new Date();
      const prefsSnap = await db.collection("preferences").get();
      if (prefsSnap.empty) return;

      for (const doc of prefsSnap.docs) {
        const userId = doc.id;
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

// â”€â”€ Daily watchlist check â€” 9am Pacific â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          if (!company.name || !company.url) continue;
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
