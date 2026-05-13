const functions = require("firebase-functions");
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

const INPUT_COST  = 3  / 1_000_000;
const OUTPUT_COST = 15 / 1_000_000;

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

// Build a job search query from user preferences + resume
async function buildSearchQuery(prefs) {
  const parts = [
    prefs.jobTitle  ? `${prefs.jobTitle} jobs`         : "software jobs",
    prefs.location  ? `in ${prefs.location}`           : "remote",
    prefs.jobType && prefs.jobType !== "any" ? prefs.jobType : "",
    prefs.salaryMin ? `salary above ${prefs.salaryMin}` : "",
    "posted this week site:linkedin.com OR site:indeed.com OR site:greenhouse.io",
  ].filter(Boolean).join(" ");
  return parts;
}

// Run a job search for one user and save the digest
async function runJobSearch(userId, prefs) {
  const query = await buildSearchQuery(prefs);

  // Build a resume-aware system prompt if resume is provided
  let searchSystem = "You are a job search agent. Search for current job listings matching the user's criteria and return the top 5 opportunities. For each: job title, company, location, salary if listed, and the URL. Be concise.";
  if (prefs.resume && prefs.resume.trim()) {
    searchSystem += `\n\nThe user's resume is provided below. Use it to find roles that match their actual experience and skills:\n\n${prefs.resume.slice(0, 3000)}`;
  }

  const userQuery = prefs.resume
    ? `Find the best current job listings that match this candidate's background. Search query: ${query}`
    : `Find the best current job listings for: ${query}`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 2048,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    system:     searchSystem,
    messages:   [{ role: "user", content: userQuery }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

  await db.collection("digests").add({
    userId, query, results: text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (response.usage) {
    const { input_tokens, output_tokens } = response.usage;
    await db.collection("activity").add({
      userId, view: "job_search",
      inputTokens: input_tokens, outputTokens: output_tokens,
      cost: (input_tokens * INPUT_COST) + (output_tokens * OUTPUT_COST),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return text;
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
      const kbDoc = await db.collection("knowledge").doc(userId).get();
      if (kbDoc.exists) {
        const kb = kbDoc.data();
        const parts = [];
        if (kb.currentResume)      parts.push(`CURRENT RESUME:\n${kb.currentResume}`);
        if (kb.currentPosition)    parts.push(`CURRENT POSITION: ${kb.currentPosition}`);
        if (kb.previousPositions)  parts.push(`PREVIOUS EXPERIENCE:\n${kb.previousPositions}`);
        if (kb.targetRole)         parts.push(`TARGET ROLE: ${kb.targetRole}`);
        if (kb.skills)             parts.push(`SKILLS: ${kb.skills}`);
        if (kb.education)          parts.push(`EDUCATION: ${kb.education}`);
        if (kb.additionalContext)  parts.push(`ADDITIONAL CONTEXT:\n${kb.additionalContext}`);
        if (parts.length > 0) {
          fullSystem += `\n\n--- USER BACKGROUND ---\n${parts.join("\n\n")}`;
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
  const { userId, currentResume, currentPosition, previousPositions,
          targetRole, skills, education, additionalContext } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("knowledge").doc(userId).set({
      currentResume:     currentResume     || "",
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
  const { userId, jobTitle, location, jobType, salaryMin, resume,
          experienceLevel, remoteOnly, industries, companySize } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("preferences").doc(userId).set({
      jobTitle:        jobTitle        || "",
      location:        location        || "",
      jobType:         jobType         || "any",
      salaryMin:       salaryMin       || "",
      resume:          resume          || "",
      experienceLevel: experienceLevel || "",
      remoteOnly:      remoteOnly      || false,
      industries:      industries      || "",
      companySize:     companySize     || "any",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save preferences" });
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
app.get("/jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests").where("userId", "==", req.params.userId).get();
    const jobs = sortByDate(snap.docs).slice(0, 30).map(d => ({ id: d.id, ...d.data() }));
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
    const results = await runJobSearch(userId, prefs);
    res.json({ ok: true, results });
  } catch (err) {
    console.error("Search now error:", err.message);
    res.status(500).json({ error: "Search failed. Please try again." });
  }
});

exports.api = functions.https.onRequest(app);

// ── Daily job search — 8am Pacific ───────────────────────────────────────────
exports.dailyJobSearch = functions.pubsub
  .schedule("0 8 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    try {
      const prefsSnap = await db.collection("preferences").get();
      if (prefsSnap.empty) return null;
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
    return null;
  });
