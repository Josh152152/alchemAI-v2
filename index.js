import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs/promises';
import admin from 'firebase-admin';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK (make sure to set GOOGLE_APPLICATION_CREDENTIALS or initialize with service account)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(), // or use serviceAccountKey.json
  });
}
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper to load agent specification prompt
async function loadAgentSpecification() {
  return await fs.readFile('./agent_specification.txt', 'utf-8');
}

// Fetch recent chat history for user from Firestore, return as OpenAI messages array
async function fetchChatHistory(uid, limit = 10) {
  const chatsSnapshot = await db
    .collection('users')
    .doc(uid)
    .collection('chats')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  // Reverse order so oldest first
  const chats = [];
  chatsSnapshot.docs.reverse().forEach(doc => {
    const data = doc.data();
    if (data.prompt) {
      chats.push({ role: 'user', content: data.prompt });
    }
    if (data.reply) {
      chats.push({ role: 'assistant', content: data.reply });
    }
  });

  return chats;
}

app.post('/openai', async (req, res) => {
  const { prompt, uid } = req.body;
  if (!prompt || !uid) {
    return res.status(400).json({ error: 'Missing prompt or uid' });
  }

  try {
    // Load agent specification from file
    const systemPrompt = await loadAgentSpecification();

    // Fetch recent conversation history
    const chatHistory = await fetchChatHistory(uid);

    // Build messages array for OpenAI request
    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: prompt },
    ];

    // Call OpenAI GPT-4
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
    });

    const reply = completion.choices[0].message.content;

    // Save user prompt and AI reply to Firestore
    await db.collection('users').doc(uid).collection('chats').add({
      prompt,
      reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ reply });
  } catch (error) {
    console.error('OpenAI request failed:', error);
    res.status(500).json({ error: error.message || 'OpenAI request failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
