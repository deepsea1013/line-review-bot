import express from 'express';
import line from '@line/bot-sdk';
import OpenAI from 'openai';

// 環境変数の読み込み（ローカル用。Renderでは不要）
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// LINE Botの設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'SdpqLzky299pljImmG5FTudhe1aILlS/FNy04zVT2BINYEgvqhgcxeWkab/paJH8/wojoroo89pfpHF+byaJgZrF1brIeUcRGGsYT7e5LZ+QWFU1H1uWfW1BLBoeBlcW/HrY1VbJUiyCqs1D83aEzAdB04t89/1O/w1cDnyilFU=',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '7752ec2a6d1103d794cf1c13ad16270e',
};

const client = new line.Client(config);

// OpenAIの設定（v4形式）
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,  // ← これだけでOK
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userMessage = event.message.text;

  const prompt = `
以下はユーザーからの小説です。読者としてレビューをお願いします：
${userMessage}
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: "user", content: prompt }],
  });

  const replyText = completion.choices[0].message.content;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
