const functions = require("firebase-functions");
const express   = require("express");
const cors      = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin     = require("firebase-admin");

// No credentials needed — Cloud Functions runs inside Firebase automatically
admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const db = admin.firestore();

const DEFAULT_SYSTEM = `You are a job search assistant helping the user land their next role. You help with:
- Finding relevant job opportunities based on their skills, experience, and preferences
- Researching companies, culture, salary ranges, and hiring processes
- Tailoring resumes and cover letters for specific roles
- Interview preparation and common questions
- Job search strategy and networking advice

Be specific, practical, and encouraging. If you don't yet know the user's background, location, or target role, ask for those details — it lets you give much more targeted help. Always give concrete next steps.`;

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required and must be a non-empty string" });
  }

  const priorMessages = Array.isArray(history) ? history.slice(0, -1) : [];
  const messages = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() },
  ];

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: typeof systemPrompt === "string" && systemPrompt.trim() ? systemPrompt : DEFAULT_SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });

    // Collect all text blocks (web search results are woven in automatically)
    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n") || "I couldn't generate a response. Please try again.";

    res.json({ reply });
  } catch (error) {
    console.error("Anthropic API error:", error.message);
    res.status(500).json({ error: "Failed to get a response. Please try again." });
  }
});

app.post("/history/save", async (req, res) => {
  const { userId, view, userMessage, assistantReply } = req.body;
  if (!userId || !userMessage || !assistantReply) {
    return res.status(400).json({ error: "userId, userMessage, and assistantReply are required" });
  }
  try {
    await db.collection("chats").add({
      userId,
      view: view || "search",
      userMessage,
      assistantReply,
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

    const messages = snapshot.docs
      .reverse()
      .flatMap((doc) => {
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

// Save job search preferences for a user
app.post("/preferences/save", async (req, res) => {
  const { userId, jobTitle, location, jobType, salaryMin } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    await db.collection("preferences").doc(userId).set({
      jobTitle:  jobTitle  || "",
      location:  location  || "",
      jobType:   jobType   || "any",
      salaryMin: salaryMin || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("Preferences save error:", err.message);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// Get preferences for a user
app.get("/preferences/:userId", async (req, res) => {
  try {
    const doc = await db.collection("preferences").doc(req.params.userId).get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) {
    console.error("Preferences get error:", err.message);
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

// Get daily job digest for a user
app.get("/digest/:userId", async (req, res) => {
  try {
    const snapshot = await db.collection("digests")
      .where("userId", "==", req.params.userId)
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    const digests = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ digests });
  } catch (err) {
    console.error("Digest get error:", err.message);
    res.status(500).json({ error: "Failed to load digest" });
  }
});

exports.api = functions.https.onRequest(app);

// ── Daily job search — runs every day at 8am Pacific ──────────────────────────
exports.dailyJobSearch = functions.pubsub
  .schedule("0 8 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    try {
      // Get all users who have saved preferences
      const prefsSnap = await db.collection("preferences").get();
      if (prefsSnap.empty) return null;

      for (const doc of prefsSnap.docs) {
        const userId = doc.id;
        const prefs  = doc.data();

        const query = [
          prefs.jobTitle  ? `${prefs.jobTitle} jobs`  : "software jobs",
          prefs.location  ? `in ${prefs.location}`    : "remote",
          prefs.jobType   !== "any" ? prefs.jobType   : "",
          prefs.salaryMin ? `salary above ${prefs.salaryMin}` : "",
          "posted this week site:linkedin.com OR site:indeed.com OR site:greenhouse.io",
        ].filter(Boolean).join(" ");

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 2048,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: `You are a job search assistant. Search for current job listings matching the user's criteria and return a clean summary of the top 5 opportunities. For each job include: job title, company, location, salary if listed, and the URL. Be concise.`,
          messages: [{ role: "user", content: `Find me the best current job listings for: ${query}` }],
        });

        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n\n");

        await db.collection("digests").add({
          userId,
          query,
          results: text,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Daily digest saved for ${userId}`);
      }
    } catch (err) {
      console.error("Daily job search error:", err.message);
    }
    return null;
  });
