import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import OpenAI from "openai";
import fs from "fs/promises";
import { google } from "googleapis";

// Initialize Express app
const app = express();

// Replace with your frontend URL for CORS
const allowedOrigin = "https://alchemai-v2.webflow.io";

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

app.use(express.json());

// Initialize Firebase Admin SDK with service account
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

// Google Sheets API client (will be initialized once)
let sheetsApi;

async function initSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  sheetsApi = google.sheets({ version: 'v4', auth: authClient });
}

// Initialize Google Sheets client before starting server
await initSheetsClient();

async function appendToSheet(dataRow) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1', // Sheet name only, Google appends rows automatically
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [dataRow],
      },
    });

    console.log('Appended data to Google Sheet:', dataRow);
  } catch (err) {
    console.error('Error appending to Google Sheet:', err);
  }
}

// Load the agent's system prompt (fallback if file missing)
async function loadAgentSpecification() {
  try {
    return await fs.readFile("./agent_specification.txt", "utf-8");
  } catch (err) {
    console.error("Failed to load agent specification:", err);
    return "You are a helpful AI assistant.";
  }
}

// Fetch last N chat messages for a user from Firestore
async function fetchChatHistory(uid, limit = 10) {
  try {
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

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

// POST endpoint to handle OpenAI chat requests
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

    // Save user prompt and AI reply to Firestore
    await db.collection("users").doc(uid).collection("chats").add({
      prompt,
      reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Prepare data row for Google Sheets (customize columns later)
    const dataRow = [
      new Date().toISOString(), // Timestamp
      uid,                     // User ID
      prompt,                  // Employer's input
      reply,                   // AI reply
    ];

    // Append row to Google Sheet
    await appendToSheet(dataRow);

    // Respond to frontend
    res.json({ reply });
  } catch (error) {
    console.error("OpenAI request failed:", error);
    res.status(500).json({ error: error.message || "OpenAI request failed" });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
