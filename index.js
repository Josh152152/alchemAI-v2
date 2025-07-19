import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs/promises';
import admin from 'firebase-admin';

const app = express();

// Configure CORS to accept requests only from your Webflow frontend domain
app.use(cors({
  origin: 'https://alchemai-v2.webflow.io', // <-- update this to your actual Webflow domain if different
  credentials: true,
}));

app.use(express.json());

// Initialize Firebase Admin SDK using service account JSON stored in environment variable
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('FIREBASE_SERVICE_ACCOUNT environment variable is not set!');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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
