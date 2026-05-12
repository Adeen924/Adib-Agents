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

app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    res.json({
      reply: response.content[0].text,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});