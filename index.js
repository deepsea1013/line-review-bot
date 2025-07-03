import express from 'express';
import * as line from '@line/bot-sdk';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// LINE Botの設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// OpenAI設定
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ユーザー状態保存
const userStates = {};

const genres = [
  "異世界ファンタジー", "現代ファンタジー", "SF", "恋愛", "ラブコメ",
  "現代ドラマ", "ホラー", "ミステリー", "エッセイ・ノンフィクション",
  "歴史・時代系", "詩・童話", "その他"
];

const aspects = [
  "ストーリー", "キャラクター", "構成", "文章", "総合"
];

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
  if (event.type !== 'message') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ごめんなさい、画像やスタンプ等は解析できないんです…',
    });
  }

  const userId = event.source.userId;
  const message = event.message.text;

  if (!userStates[userId]) {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ジャンルを選んでください：\n${genres.join(' / ')}`,
    });
  }

  const state = userStates[userId];

  if (state.step === 'genre') {
    if (!genres.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ジャンルを正しく選んでください：\n${genres.join(' / ')}`,
      });
    }

    state.genre = message;
    state.step = 'aspect';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `次にレビューの観点を選んでください：\n${aspects.join(' / ')}`,
    });
  }

  if (state.step === 'aspect') {
    if (!aspects.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `観点を正しく選んでください：\n${aspects.join(' / ')}`,
      });
    }

    state.aspect = message;
    state.step = 'awaiting_text';

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'あなたの小説を送ってください（1000字以上）',
    });
  }

  if (state.step === 'awaiting_text') {
    if (message.length < 1000) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '1000字以上で送信するようにしてください。',
      });
    }

    const prompt = `
ジャンル: ${state.genre}
観点: ${state.aspect}

以下はユーザーの小説です。上記のジャンルと観点に基づき、読者として丁寧なレビューをお願いします。

${message}
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: "user", content: prompt }],
    });

    const replyText = completion.choices[0].message.content;

    // 状態をリセット（次回またジャンル選びから）
    userStates[userId] = null;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText,
    });
  }
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
