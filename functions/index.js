const functions = require("firebase-functions");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" })); // allow large resume pastes

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = admin.firestore();

// claude-sonnet-4-5 pricing
const INPUT_COST  = 3  / 1_000_000;  // $3 per million input tokens
const OUTPUT_COST = 15 / 1_000_000;  // $15 per million output tokens

const DEFAULT_SYSTEM = `You are a job search assistant helping the user land their next role. You help with:
- Finding relevant job opportunities based on their skills, experience, and preferences
- Researching companies, culture, salary ranges, and hiring processes
- Tailoring resumes and cover letters for specific roles
- Interview preparation and common questions
- Job search strategy and networking advice

Be specific, practical, and encouraging. If you don't yet know the user's background, location, or target role, ask for those details. Always give concrete next steps.`;

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Backend is running"));

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history, userId } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required" });
  }

  // Inject knowledge base into system prompt if userId provided
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
          fullSystem += `\n\n--- USER BACKGROUND (use this to personalise all responses) ---\n${parts.join("\n\n")}`;
        }
      }
    } catch { /* non-fatal — continue without knowledge */ }
  }

  const priorMessages = Array.isArray(history) ? history.slice(0, -1) : [];
  const messages = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() },
  ];

  try {
    const response = await anthropic.messages.create({
      model:   "claude-sonnet-4-5",
      max_tokens: 2048,
      system:  fullSystem,
      tools:   [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n") || "I couldn't generate a response. Please try again.";

    // Track usage
    if (userId && response.usage) {
      const { input_tokens, output_tokens } = response.usage;
      const cost = (input_tokens * INPUT_COST) + (output_tokens * OUTPUT_COST);
      db.collection("activity").add({
        userId,
        view:         req.body.view || "chat",
        inputTokens:  input_tokens,
        outputTokens: output_tokens,
        cost,
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
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
      userId, view: view || "search", userMessage, assistantReply,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Firestore save error:", err.message);
    res.status(500).json({ error: "Failed to save message" });
  }
});

app.get("/history/:userId/:view", async (req, res) => {
  const { userId, view } = req.params;
  try {
    const snapshot = await db.collection("chats")
      .where("userId", "==", userId)
      .where("view", "==", view)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    const messages = snapshot.docs.reverse().flatMap((doc) => {
      const d = doc.data();
      return [
        { role: "user",      content: d.userMessage },
        { role: "assistant", content: d.assistantReply },
      ];
    });
    res.json({ messages });
  } catch (err) {
    console.error("Firestore load error:", err.message);
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── Stats (24-hour dashboard) ─────────────────────────────────────────────────
app.get("/stats/:userId", async (req, res) => {
  try {
    const snap = await db.collection("activity")
      .where("userId", "==", req.params.userId)
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = snap.docs.filter((d) => {
      const ts = d.data().createdAt;
      return ts && ts.toMillis() > cutoff;
    });

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
      totalTokens: totals.inputTokens + totals.outputTokens,
      costFormatted: `$${totals.cost.toFixed(4)}`,
    });
  } catch (err) {
    console.error("Stats error:", err.message);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// ── Documents (resumes + cover letters) ───────────────────────────────────────
app.get("/documents/:userId/:type", async (req, res) => {
  const { userId, type } = req.params;
  try {
    const snap = await db.collection("documents")
      .where("userId", "==", userId)
      .where("type", "==", type)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ documents: docs });
  } catch (err) {
    console.error("Documents error:", err.message);
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
    console.error("Document save error:", err.message);
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

// ── Job Applications tracker ──────────────────────────────────────────────────
app.get("/applications/:userId", async (req, res) => {
  try {
    const snap = await db.collection("applications")
      .where("userId", "==", req.params.userId)
      .orderBy("createdAt", "desc")
      .get();
    const applications = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ applications });
  } catch (err) {
    console.error("Applications error:", err.message);
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
    console.error("Application save error:", err.message);
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

// ── Knowledge base ────────────────────────────────────────────────────────────
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
    console.error("Knowledge save error:", err.message);
    res.status(500).json({ error: "Failed to save knowledge base" });
  }
});

// ── Jobs found ────────────────────────────────────────────────────────────────
app.get("/jobs/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests")
      .where("userId", "==", req.params.userId)
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

// ── Preferences ───────────────────────────────────────────────────────────────
app.post("/preferences/save", async (req, res) => {
  const { userId, jobTitle, location, jobType, salaryMin } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("preferences").doc(userId).set(
      { jobTitle: jobTitle||"", location: location||"", jobType: jobType||"any",
        salaryMin: salaryMin||"", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

app.get("/preferences/:userId", async (req, res) => {
  try {
    const doc = await db.collection("preferences").doc(req.params.userId).get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

// ── Daily digest ──────────────────────────────────────────────────────────────
app.get("/digest/:userId", async (req, res) => {
  try {
    const snap = await db.collection("digests")
      .where("userId", "==", req.params.userId)
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    const digests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ digests });
  } catch (err) {
    res.status(500).json({ error: "Failed to load digest" });
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

        const query = [
          prefs.jobTitle  ? `${prefs.jobTitle} jobs`      : "software jobs",
          prefs.location  ? `in ${prefs.location}`        : "remote",
          prefs.jobType !== "any" ? prefs.jobType         : "",
          prefs.salaryMin ? `salary above ${prefs.salaryMin}` : "",
          "posted this week site:linkedin.com OR site:indeed.com OR site:greenhouse.io",
        ].filter(Boolean).join(" ");

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 2048,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: "You are a job search assistant. Search for current job listings matching the user's criteria and return the top 5 opportunities. For each: job title, company, location, salary if listed, and the URL. Be concise.",
          messages: [{ role: "user", content: `Find the best current job listings for: ${query}` }],
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
            userId, view: "daily_digest",
            inputTokens: input_tokens, outputTokens: output_tokens,
            cost: (input_tokens * INPUT_COST) + (output_tokens * OUTPUT_COST),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (err) {
      console.error("Daily job search error:", err.message);
    }
    return null;
  });
