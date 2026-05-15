const functions = require("firebase-functions/v1");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = admin.firestore();

// Sonnet — used for chat and resume parsing
const INPUT_COST_SONNET  = 3    / 1_000_000;
const OUTPUT_COST_SONNET = 15   / 1_000_000;
// Haiku 3.5 (claude-3-5-haiku-20241022) — used for job search, 3-4x cheaper
const INPUT_COST_HAIKU   = 0.80 / 1_000_000;
const OUTPUT_COST_HAIKU  = 4    / 1_000_000;
// Legacy alias used by chat/parse routes
const INPUT_COST  = INPUT_COST_SONNET;
const OUTPUT_COST = OUTPUT_COST_SONNET;

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

// Run a job search for one user — uses Haiku to reduce cost
async function runJobSearch(userId, prefs) {
  const query = buildSearchQuery(prefs);

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
    model:      "claude-sonnet-4-5",
    max_tokens: 1500,
    // max_uses:1 limits Claude to ONE web search call — main cost control lever
    tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
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
      model:      "claude-sonnet-4-5",
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
          industries, companySize, postedWithin, customSites } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("preferences").doc(userId).set({
      jobTitle:        jobTitle        || "",
      location:        location        || "",   // legacy fallback
      locationCity:    locationCity    || "",
      locationRadius:  locationRadius  || "",
      jobType:         jobType         || "any",
      salaryMin:       salaryMin       || "",
      experienceLevel: experienceLevel || "",
      remoteOnly:      remoteOnly      || false,
      industries:      industries      || "",
      companySize:     companySize     || "any",
      postedWithin:    postedWithin    || "14",
      customSites:     customSites     || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
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
      model:      "claude-sonnet-4-5",
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
    const prefDoc = await db.collection("preferences").doc(userId).get();
    if (!prefDoc.exists) {
      return res.status(400).json({ error: "No preferences saved yet. Please set your preferences first." });
    }
    const prefs = prefDoc.data();
    const jobs = await runJobSearch(userId, prefs);
    res.json({ ok: true, jobCount: jobs.length });
  } catch (err) {
    console.error("Search now error:", err.message, err.stack);
    // Return the real error so it's visible in the UI for debugging
    res.status(500).json({ error: err.message || "Search failed. Please try again." });
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
      model:      "claude-sonnet-4-5",
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
  }

  return newJobs.length;
}

// ── Daily job search — 8am Pacific ───────────────────────────────────────────
exports.dailyJobSearch = onSchedule(
  { schedule: "0 8 * * *", timeZone: "America/Los_Angeles" },
  async () => {
    try {
      const prefsSnap = await db.collection("preferences").get();
      if (prefsSnap.empty) return;
      for (const doc of prefsSnap.docs) {
        const userId = doc.id;
        const prefs  = doc.data();
        try {
          await runJobSearch(userId, prefs);
          console.log(`Daily digest saved for ${userId}`);
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
