const express = require('express');
const line = require('@line/bot-sdk');
const { Configuration, OpenAIApi } = require("openai");

const app = express();
const port = process.env.PORT || 3000;

// ここに自分のLINE情報を入れてね
const config = {
  channelAccessToken: 'ここにLINEアクセストークン',
  channelSecret: 'ここにLINEチャネルシークレット',
};

const client = new line.Client(config);

// ここにOpenAIのキーを入れてね（https://platform.openai.com/）
const openai = new OpenAIApi(new Configuration({
  apiKey: 'ここにOpenAIのAPIキー',
}));

app.post('/webhook', line.middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(() => res.end());
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userMessage = event.message.text;

  const prompt = `
  以下はユーザーからの小説です。読者としてレビューをお願いします：
  ${userMessage}
  `;

  const completion = await openai.createChatCompletion({
    model: 'gpt-4',
    messages: [{ role: "user", content: prompt }],
  });

  const replyText = completion.data.choices[0].message.content;

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
