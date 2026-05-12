require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-key.json");

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

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage || typeof userMessage !== "string" || userMessage.trim() === "") {
    return res.status(400).json({ error: "message is required and must be a non-empty string" });
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: userMessage.trim(),
        },
      ],
    });

    res.json({
      reply: response.content[0].text,
    });
  } catch (error) {
    console.error("Anthropic API error:", error.message);
    res.status(500).json({ error: "Failed to get a response. Please try again." });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
