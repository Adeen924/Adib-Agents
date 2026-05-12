require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// TODO: before going live, restrict origin to your actual domain:
// app.use(cors({ origin: "https://agents.adibmazloom.com" }));
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const db = admin.firestore();

app.get("/", (req, res) => {
  res.send("Backend is running");
});

// Save a message pair to Firestore
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

// Load recent chat history for a user + view
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

const DEFAULT_SYSTEM = `You are a job search assistant helping the user land their next role. You help with:
- Finding relevant job opportunities based on their skills, experience, and preferences
- Researching companies, culture, salary ranges, and hiring processes
- Tailoring resumes and cover letters for specific roles
- Interview preparation and common questions
- Job search strategy and networking advice

Be specific, practical, and encouraging. If you don't yet know the user's background, location, or target role, ask for those details — it lets you give much more targeted help. Always give concrete next steps.`;

app.post("/chat", async (req, res) => {
  const { message, systemPrompt, history } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required and must be a non-empty string" });
  }

  // Build message list: prior history + new user message
  const priorMessages = Array.isArray(history) ? history.slice(0, -1) : [];
  const messages = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() },
  ];

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: typeof systemPrompt === "string" && systemPrompt.trim() ? systemPrompt : DEFAULT_SYSTEM,
      messages,
    });

    res.json({ reply: response.content[0].text });
  } catch (error) {
    console.error("Anthropic API error:", error.message);
    res.status(500).json({ error: "Failed to get a response. Please try again." });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
