import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs/promises';
import admin from 'firebase-admin';

const app = express();

// Configure CORS to accept requests only from your Webflow frontend domain
app.use(cors({
  origin: 'https://alchemai-v2.webflow.io', // <-- update if your domain changes
  credentials: true,
}));

app.use(express.json());

// Initialize Firebase Admin SDK (set GOOGLE_APPLICATION_CREDENTIALS or use service account key)
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
  try {
    return await fs.readFile('./agent_specification.txt', 'utf-8');
  } catch (err) {
    console.error('Failed to load agent specification:', err);
    return 'You are a helpful AI assistant.'; // fallback prompt
  }
}

// Fetch recent chat history for user from Firestore, return as OpenAI messages array
async function fetchChatHistory(uid, limit = 10) {
  try {
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
      if (data.prompt) chats.push({ role: 'user', content: data.prompt });
      if (data.reply) chats.push({ role: 'assistant', content: data.reply });
    });

    return chats;
  } catch (err) {
    console.error('Failed to fetch chat history:', err);
    return [];
  }
}

app.post('/openai', async (req, res) => {
  const { prompt, uid } = req.body;

  if (!prompt || !uid) {
    return res.status(400).json({ error: 'Missing prompt or uid' });
  }

  try {
    const systemPrompt = await loadAgentSpecification();
    const chatHistory = await fetchChatHistory(uid);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: prompt },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
    });

    const reply = completion.choices[0]?.message?.content || 'Sorry, no response generated.';

    // Save chat to Firestore only if reply is valid
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
