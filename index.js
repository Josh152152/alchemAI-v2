import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import OpenAI from "openai";
import fs from "fs/promises";

// Initialize Express app
const app = express();

// Replace with your frontend URL for CORS
const allowedOrigin = "https://yourdomain.com";

app.use(cors({
  origin: 'https://alchemai-v2.webflow.io', // your actual frontend domain here
  credentials: true
}));

app.use(express.json());

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJSON) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT environment variable");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(serviceAccountJSON);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Load agent specification prompt from file (fallback to default)
async function loadAgentSpecification() {
  try {
    return await fs.readFile("./agent_specification.txt", "utf-8");
  } catch (err) {
    console.error("Failed to load agent specification:", err);
    return "You are a helpful AI assistant.";
  }
}

// Fetch last N chat messages from Firestore for user
async function fetchChatHistory(uid, limit = 10) {
  try {
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    // Reverse so oldest first
    const chats = [];
    snapshot.docs.reverse().forEach((doc) => {
      const data = doc.data();
      if (data.prompt) chats.push({ role: "user", content: data.prompt });
      if (data.reply) chats.push({ role: "assistant", content: data.reply });
    });
    return chats;
  } catch (err) {
    console.error("Error fetching chat history:", err);
    return [];
  }
}

// POST /openai endpoint
app.post("/openai", async (req, res) => {
  const { prompt, uid } = req.body;
  if (!prompt || !uid) {
    return res.status(400).json({ error: "Missing prompt or uid" });
  }

  try {
    const systemPrompt = await loadAgentSpecification();
    const chatHistory = await fetchChatHistory(uid);

    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory,
      { role: "user", content: prompt },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
    });

    const reply = completion.choices[0]?.message?.content || "Sorry, no response generated.";
    console.log("OpenAI reply:", reply);

    // Save conversation to Firestore
    await db.collection("users").doc(uid).collection("chats").add({
      prompt,
      reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ reply });
  } catch (error) {
    console.error("OpenAI request failed:", error);
    res.status(500).json({ error: error.message || "OpenAI request failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
