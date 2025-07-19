import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/openai', async (req, res) => {
  const { prompt, uid } = req.body;
  if (!prompt || !uid) {
    return res.status(400).json({ error: 'Missing prompt or uid' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'OpenAI request failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
