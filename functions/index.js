const functions = require("firebase-functions/v1");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");
const Stripe    = require("stripe");

admin.initializeApp();

// Live site URL — used as the click-through destination in push notifications.
// Update this if you move to a custom domain.
const SITE_URL = "https://adeen924.github.io/Adib-Agents";

const app = express();
app.use(cors({ origin: true }));

// ── Stripe webhook — must be registered BEFORE express.json() so we get the raw body ──
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

// Sonnet — used for chat and resume parsing
const INPUT_COST_SONNET  = 3    / 1_000_000;
const OUTPUT_COST_SONNET = 15   / 1_000_000;
// Legacy alias used by chat/parse routes
const INPUT_COST  = INPUT_COST_SONNET;
const OUTPUT_COST = OUTPUT_COST_SONNET;

// ── Subscription tiers ────────────────────────────────────────────────────────
// Enforce these limits in runJobSearch and the scheduler.
// When Stripe is wired up, the webhook sets tier in the `users` collection.
const TIERS = {
  free: {
    label:               "Free",
    maxSearchesPerDay:   1,    // automated searches/day the scheduler will fire
    webSearchesPerQuery: 1,    // max_uses on the web_search tool
    maxOutputTokens:     1500, // max_tokens for the job search call
    customSites:         false, // whether prefs.customSites is included in the query
    maxTargetCompanies:  3,    // watchlist cap
  },
  pro: {
    label:               "Pro",
    maxSearchesPerDay:   4,
    webSearchesPerQuery: 3,
    maxOutputTokens:     2500,
    customSites:         true,
    maxTargetCompanies:  50,
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

const DEFAULT_SYSTEM = `You are an AI job search agent helping the user land their next role. You help with:
- Interview preparation and practice questions
- Salary negotiation advice
- Career strategy and decision-making
- Company research

Be specific, practical, and encouraging. Always give concrete next steps.`;

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    entry:     "entry level 0-2 years experience",
    mid:       "3-5 years experience",
    senior:    "senior 5+ years",
    staff:     "staff principal 10+ years",
    manager:   "engineering manager director",
    executive: "VP executive",
  };

  // Support both old `location` field and new `locationCity`+`locationRadius`
  let locationStr = "";
  if (prefs.remoteOnly) {
    locationStr = "remote";
  } else if (prefs.locationCity) {
    locationStr = prefs.locationRadius
      ? `near "${prefs.locationCity}" within ${prefs.locationRadius} miles`
      : `"${prefs.locationCity}"`;
  } else if (prefs.location) {
    locationStr = prefs.location;
  }

  const postedStr = prefs.postedWithin ? `posted last ${prefs.postedWithin} days` : "posted this month";

  // Built-in job boards + any custom sites the user added in Preferences
  const builtInSites = [
    "site:hiring.cafe",
    "site:spacecrew.com",
    "site:linkedin.com/jobs",
    "site:indeed.com",
    "site:greenhouse.io",
    "site:lever.co",
  ];
  const customSiteFilters = (prefs.customSites || "")
    .split(",")
    .map(s => s.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""))
    .filter(Boolean)
    .map(s => `site:${s}`);
  const allSites = [...customSiteFilters, ...builtInSites].join(" OR ");

  const parts = [
    prefs.jobTitle        ? `"${prefs.jobTitle}"`                  : "software engineer",
    locationStr,
    prefs.experienceLevel ? expLabels[prefs.experienceLevel]       : "",
    prefs.jobType && prefs.jobType !== "any" ? prefs.jobType       : "",
    prefs.salaryMin       ? `salary ${prefs.salaryMin}`            : "",
    prefs.industries      ? prefs.industries.split(",")[0]?.trim() : "",
    postedStr,
    allSites,
  ].filter(Boolean).join(" ");
  return parts;
}

// Run a job search for one user — limits are tier-based
async function runJobSearch(userId, prefs, tier = "free") {
  const tierConfig = TIERS[tier] || TIERS.free;

  // Free tier: strip custom sites from the search query
  const effectivePrefs = tierConfig.customSites
    ? prefs
    : { ...prefs, customSites: "" };

  const query = buildSearchQuery(effectivePrefs);

  // Fetch resume from knowledge base for better matching
  let resumeSnippet = "";
  try {
    const kbDoc = await db.collection("knowledge").doc(userId).get();
    if (kbDoc.exists && kbDoc.data().resume) {
      resumeSnippet = kbDoc.data().resume.slice(0, 2000);
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
    prefs.postedWithin    ? `Posted within last ${prefs.postedWithin} days — REJECT older postings` : "Must be a recent posting",
  ].filter(Boolean).join("\n");

  // Tell Claude which jobs were already found this week so it returns different ones
  const seenSection = recentJobs.length > 0
    ? `\nALREADY FOUND THIS WEEK — do NOT return these again, find DIFFERENT jobs:\n${
        recentJobs.slice(0, 20).map(j => `- ${j.company}: ${j.title}`).join("\n")
      }\n`
    : "";

  const systemPrompt = `You are a job search agent. Search job boards and return ONLY a raw JSON array — no markdown, no explanation, nothing else.

REQUIRED CRITERIA (reject any job that does not match):
${criteria || "No specific criteria."}
${seenSection}
Rules:
- Skip jobs where the posted experience requirement is significantly higher than the user's level
- Only include direct job posting URLs (not search pages)
- Prefer postings from the last 14 days
${resumeSnippet ? `- Match roles to this candidate background:\n${resumeSnippet}` : ""}

Return 5 jobs as a JSON array. Field rules:
- url: CRITICAL — only include a URL you found verbatim in your search results. Do NOT construct, guess, or modify any URL. A fabricated URL is worse than an empty string — use "" if you cannot confirm the exact direct link to this specific posting.
- posted: exact date as "Month DD, YYYY" (e.g. "May 10, 2026") or relative like "2 days ago". Never just a year. If unknown use "".
- description: full job description — include what the role does, day-to-day responsibilities, required skills/qualifications, nice-to-haves, and any other details from the posting. Aim for at least 6-8 sentences. The more detail the better.

[{"title":"","company":"","location":"","salary":"","experience":"","description":"","url":"","posted":""}]`;

  const userQuery = `Find 5 current job listings. Search: ${query}`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: tierConfig.maxOutputTokens,
    tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: tierConfig.webSearchesPerQuery }],
    system:     systemPrompt,
    messages:   [{ role: "user", content: userQuery }],
  });

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
  } catch {
    console.error("Could not parse job search JSON:", raw.slice(0, 300));
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
      title:       job.title       || "",
      company:     job.company     || "",
      location:    job.location    || "",
      salary:      job.salary      || "",
      experience:  job.experience  || "",
      description: job.description || "",
      url:         job.url         || "",
      posted:      job.posted      || "",
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    })
  );
  await Promise.all(savePromises);

  // Send push notification if new jobs were found
  if (uniqueJobs.length > 0) {
    const preview = uniqueJobs.slice(0, 2).map(j => `${j.title} at ${j.company}`).join(" · ");
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Backend is running"));

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history, userId, view } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required" });
  }

  let fullSystem = typeof systemPrompt === "string" && systemPrompt.trim()
    ? systemPrompt : DEFAULT_SYSTEM;

  if (userId) {
    try {
      // Inject knowledge base (background + resume)
      const kbDoc = await db.collection("knowledge").doc(userId).get();
      if (kbDoc.exists) {
        const kb = kbDoc.data();
        const parts = [];
        if (kb.currentPosition)    parts.push(`CURRENT POSITION: ${kb.currentPosition}`);
        if (kb.previousPositions)  parts.push(`PREVIOUS EXPERIENCE:\n${kb.previousPositions}`);
        if (kb.targetRole)         parts.push(`TARGET ROLE: ${kb.targetRole}`);
        if (kb.skills)             parts.push(`SKILLS: ${kb.skills}`);
        if (kb.education)          parts.push(`EDUCATION: ${kb.education}`);
        if (kb.additionalContext)  parts.push(`ADDITIONAL CONTEXT:\n${kb.additionalContext}`);
        if (parts.length > 0) {
          fullSystem += `\n\n--- USER BACKGROUND ---\n${parts.join("\n\n")}`;
        }
        // Resume: inject as style reference for document generation
        if (kb.resume && kb.resume.trim()) {
          fullSystem += `\n\n--- RESUME STYLE REFERENCE ---\nThe user has uploaded their current resume. When creating or rewriting resumes, match the exact formatting structure, section order, tone, and length of this resume:\n\n${kb.resume.slice(0, 4000)}`;
        }
      }
    } catch { /* non-fatal */ }
  }

  const priorMessages = Array.isArray(history) ? history.slice(0, -1) : [];
  const messages = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() },
  ];

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 2048,
      system:     fullSystem,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n") || "I couldn't generate a response. Please try again.";

    if (userId && response.usage) {
      const { input_tokens, output_tokens } = response.usage;
      db.collection("activity").add({
        userId, view: view || "chat",
        inputTokens: input_tokens, outputTokens: output_tokens,
        cost: (input_tokens * INPUT_COST) + (output_tokens * OUTPUT_COST),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    res.json({ reply });
  } catch (error) {
    console.error("Anthropic API error:", error.message);
    res.status(500).json({ error: "Failed to get a response. Please try again." });
  }
});

// ── Chat history ──────────────────────────────────────────────────────────────
app.post("/history/save", async (req, res) => {
  const { userId, view, userMessage, assistantReply } = req.body;
  if (!userId || !userMessage || !assistantReply)
    return res.status(400).json({ error: "userId, userMessage, and assistantReply are required" });
  try {
    await db.collection("chats").add({
      userId, view: view || "interview", userMessage, assistantReply,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save message" });
  }
});

app.get("/history/:userId/:view", async (req, res) => {
  const { userId, view } = req.params;
  try {
    // No composite index needed — filter by view in JS
    const snap = await db.collection("chats").where("userId", "==", userId).get();
    const filtered = sortByDate(snap.docs.filter(d => d.data().view === view)).slice(0, 20).reverse();
    const messages = filtered.flatMap((doc) => {
      const d = doc.data();
      return [
        { role: "user",      content: d.userMessage },
        { role: "assistant", content: d.assistantReply },
      ];
    });
    res.json({ messages });
  } catch (err) {
    console.error("History error:", err.message);
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
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

// ── Documents ─────────────────────────────────────────────────────────────────
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

// ── Applications ──────────────────────────────────────────────────────────────
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

// ── Knowledge Base ────────────────────────────────────────────────────────────
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

// ── Preferences ───────────────────────────────────────────────────────────────
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

// ── Parse resume → structured fields ─────────────────────────────────────────
app.post("/knowledge/parse-resume", async (req, res) => {
  const { resumeText } = req.body;
  if (!resumeText || !resumeText.trim())
    return res.status(400).json({ error: "resumeText is required" });

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{
        role:    "user",
        content: `You are a resume parser. Extract structured information from the resume below and return ONLY a valid JSON object — no explanation, no markdown, no code fences, just the raw JSON.

Use these exact fields (use empty string "" for anything not found):
{
  "currentPosition": "Most recent job title and company with dates, e.g. Senior Engineer at Acme Corp (2022–present)",
  "previousPositions": "All previous roles, one per line, e.g.\\nSoftware Engineer at Startup Inc (2019–2022)\\nJunior Developer at Agency (2017–2019)",
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

// ── Digest ────────────────────────────────────────────────────────────────────
app.get("/digest/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests").where("userId", "==", req.params.userId).get();
    const digests = sortByDate(snap.docs).slice(0, 10).map(d => ({ id: d.id, ...d.data() }));
    res.json({ digests });
  } catch (err) {
    res.status(500).json({ error: "Failed to load digest" });
  }
});

// ── Jobs Found ────────────────────────────────────────────────────────────────
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

app.get("/jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("jobs").where("userId", "==", req.params.userId).get();
    const jobs = sortByDate(snap.docs).slice(0, 50).map(d => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

// ── Manual search now ─────────────────────────────────────────────────────────
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
    const prefs = prefDoc.data();
    const jobs = await runJobSearch(userId, prefs, tier);
    res.json({ ok: true, jobCount: jobs.length, tier });
  } catch (err) {
    console.error("Search now error:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Search failed. Please try again." });
  }
});

// ── User / tier management ────────────────────────────────────────────────────
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

// Admin / Stripe-webhook endpoint — sets a user's tier.
// Protect this with a shared secret before exposing to the internet.
// When integrating Stripe: call this from your webhook handler after
// a checkout.session.completed or customer.subscription.updated event.
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

// ── Stripe Checkout ───────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { userId, userEmail, lookupKey } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const key    = lookupKey || process.env.STRIPE_PRO_LOOKUP_KEY || "pro_monthly";

  try {
    const prices = await stripe.prices.list({ lookup_keys: [key], expand: ["data.product"] });
    if (!prices.data.length) return res.status(404).json({ error: "Price not found for lookup key: " + key });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: prices.data[0].id, quantity: 1 }],
      client_reference_id: userId,
      customer_email: userEmail || undefined,
      subscription_data: {
        trial_period_days: 7,
      },
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

// ── Push Notification token management ───────────────────────────────────────
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

// ── Target Companies (Watchlist) ─────────────────────────────────────────────
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

exports.api = functions.https.onRequest(app);

// ── Push notification sender ──────────────────────────────────────────────────
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

// ── Watchlist helpers ─────────────────────────────────────────────────────────
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

Return ONLY a raw JSON array — no markdown, no explanation:
[{"title":"","location":"","url":"","salary":"","description":"","posted":""}]

Rules:
- url: copy the DIRECT job posting URL verbatim from the page. Do NOT construct or guess URLs. If no direct link is visible, use the career page URL.
- description: 2-4 sentences describing the role and key requirements.
- Return up to 25 jobs; if more exist, prioritise the most recently posted.
- Return [] if the page is inaccessible or has no open positions.`;

  let jobs = [];
  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 3000,
      tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
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
    const notifBody = newJobs.slice(0, 2).map(j => j.title).join(" · ");
    sendPushNotification(userId, notifTitle, notifBody).catch(() => {});
  }

  return newJobs.length;
}

// ── Schedule helpers ──────────────────────────────────────────────────────────
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

// ── Job search — runs every hour, fires per each user's schedule ──────────────
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

// ── Daily watchlist check — 9am Pacific ──────────────────────────────────────
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
