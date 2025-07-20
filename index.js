import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import fs from "fs/promises";

admin.initializeApp();
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: functions.config().openai.key, // store in Firebase config (see below)
});

// Helper to load agent specification prompt
async function loadAgentSpecification() {
  try {
    return await fs.readFile("./agent_specification.txt", "utf-8");
  } catch (err) {
    console.error("Failed to load agent specification:", err);
    return "You are a helpful AI assistant.";
  }
}

// Fetch recent chat history for user from Firestore
async function fetchChatHistory(uid, limit = 10) {
  try {
    const chatsSnapshot = await db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const chats = [];
    chatsSnapshot.docs.reverse().forEach((doc) => {
      const data = doc.data();
      if (data.prompt) chats.push({ role: "user", content: data.prompt });
      if (data.reply) chats.push({ role: "assistant", content: data.reply });
    });

    return chats;
  } catch (err) {
    console.error("Failed to fetch chat history:", err);
    return [];
  }
}

// Export a HTTPS Firebase function to handle your OpenAI requests
export const openaiFunction = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

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

    // Save chat to Firestore
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
