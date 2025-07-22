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

// Google Sheets API client (initialized once)
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

// Fetch all chat messages for a user from Firestore (limit can be increased)
async function fetchChatHistory(uid, limit = 1000) {
  try {
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .orderBy("timestamp", "asc")  // oldest first
      .limit(limit)
      .get();

    const chats = [];
    snapshot.docs.forEach(doc => {
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

// Resume chat: returns all chat messages
app.get("/resume", async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: "Missing uid" });

  try {
    const chatHistory = await fetchChatHistory(uid);
    res.json({ chatHistory });
  } catch (err) {
    console.error("Resume chat failed:", err);
    res.status(500).json({ error: "Failed to resume chat" });
  }
});

// Finalize conversation: get full JSON summary, append to Sheets
app.post("/finalize", async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: "Missing uid" });

  try {
    const systemPrompt = await loadAgentSpecification();
    const chatHistory = await fetchChatHistory(uid);

    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory,
      {
        role: "user",
        content: "Please provide ONLY a JSON object summarizing the entire job description fields as per the schema, using empty strings for missing fields. No additional explanation."
      }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
    });

    const finalReply = completion.choices[0]?.message?.content || "";
    console.log("Final structured reply:", finalReply);

    // Parse JSON safely
    let structuredData = {};
    try {
      structuredData = JSON.parse(finalReply);
    } catch (e) {
      console.warn("Failed to parse JSON from final summary:", e);
      return res.status(500).json({ error: "AI did not return valid JSON" });
    }

    const dataRow = [
      new Date().toISOString(),                        // Timestamp
      uid,                                            // User ID
      structuredData.job_title || '',
      structuredData.responsibilities || '',
      structuredData.compensation_range || '',
      structuredData.benefits || '',
      structuredData.work_life_balance || '',
      structuredData.company_culture || '',
      structuredData.reporting_line || '',
      structuredData.team_size || '',
      structuredData.ideal_candidate_profile || '',
      structuredData.required_skills || '',
      structuredData.growth_opportunity || '',
      structuredData.company_values || '',
      structuredData.workspace_type || '',
      structuredData.unique_perks || '',
      structuredData.hiring_timeline || '',
      structuredData.candidate_type || '',
      structuredData.key_projects || '',
      structuredData.probation_details || '',
      structuredData.experience_level || '',
      structuredData.working_schedule || '',
      structuredData.location_preferences || '',
      structuredData.certifications || '',
    ];

    await appendToSheet(dataRow);

    res.json({ message: "Job description finalized and saved to Google Sheets." });
  } catch (error) {
    console.error("Finalize request failed:", error);
    res.status(500).json({ error: error.message || "Failed to finalize conversation" });
  }
});

// Existing chat endpoint
app.post("/openai", async (req, res) => {
  const { prompt, uid } = req.body;
  if (!prompt || !uid) {
    return res.status(400).json({ error: "Missing prompt or uid" });
  }

  try {
    const systemPrompt = await loadAgentSpecification();
    const chatHistory = await fetchChatHistory(uid, 10);

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
