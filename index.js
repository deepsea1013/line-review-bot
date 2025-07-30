// index.js
import express from 'express';
import * as line from '@line/bot-sdk';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userStates = {};

const genres = [
  "異世界ファンタジー", "現代ファンタジー", "SF", "恋愛", "ラブコメ",
  "現代ドラマ", "ホラー", "ミステリー", "エッセイ・ノンフィクション",
  "歴史・時代系", "詩・童話", "その他"
];
const levels = ["甘口", "中辛", "辛口"];
const MAX_CHARACTERS = 30000;

const addResetButton = (items) => {
  items.push({
    type: 'action',
    action: { type: 'message', label: 'リセット', text: 'リセット' }
  });
  return items;
};

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
  const userId = event.source.userId;
  const profile = await client.getProfile(userId);
  const userName = profile.displayName;

  if (event.type !== 'message' || event.message.type !== 'text') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ごめん、画像やスタンプはまだ読めないんだ〜'
    });
  }

  const message = event.message.text;

  if (message === 'リセット') {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ジャンルを選んでね：',
      quickReply: { items: genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } })) }
    });
  }

  if (!userStates[userId]) {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ジャンルを選んでね：',
      quickReply: { items: genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } })) }
    });
  }

  const state = userStates[userId];

  if (state.step === 'genre') {
    if (!genres.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ボタンから選んでね：',
        quickReply: { items: addResetButton(genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } }))) }
      });
    }
    state.genre = message;
    state.step = 'level';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'レビューのレベルを選んでね：',
      quickReply: { items: addResetButton(levels.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } }))) }
    });
  }

  if (state.step === 'level') {
    if (!levels.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '甘口・中辛・辛口の中から選んでね！',
        quickReply: { items: addResetButton(levels.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } }))) }
      });
    }
    state.level = message;
    state.step = 'awaiting_text';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'あなたの小説を送ってね（1000字以上でお願い！）',
      quickReply: { items: addResetButton([]) }
    });
  }

  if (state.step === 'awaiting_text' || state.step === 'awaiting_additional_text') {
    if (!state.buffer) state.buffer = "";
    state.buffer += '\n' + message;

    if (state.step === 'awaiting_text' && state.buffer.length < 1000) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '1000字以上でお願い！' });
    }

    if (state.buffer.length > MAX_CHARACTERS) {
      state.step = 'confirm_review_overflow';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '文字数が多すぎるみたい！このままレビューしてもいい？',
        quickReply: {
          items: addResetButton([
            { type: 'action', action: { type: 'message', label: 'はい', text: 'レビューしてください' } },
            { type: 'action', action: { type: 'message', label: 'いいえ', text: 'キャンセル' } }
          ])
        }
      });
    }

    state.step = 'awaiting_continue_confirm';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '続きを送る？',
      quickReply: {
        items: addResetButton([
          { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } }
        ])
      }
    });
  }

  if (state.step === 'confirm_review_overflow' && message === 'レビューしてください') {
    return generateAndSendReview(userId, userName);
  }

  if (state.step === 'awaiting_continue_confirm') {
    if (message === 'はい') {
      state.step = 'awaiting_additional_text';
      return client.replyMessage(event.replyToken, { type: 'text', text: '続きのテキストを送ってね！' });
    }
    if (message === 'いいえ') {
      state.step = 'generating_review';
      await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！読ませてもらうね🌟' });
      generateAndSendReview(userId, userName);
      return;
    }
  }

  if (state.step === 'review_done') {
    const prompt = `以下はユーザーが送った小説と、そのレビューです。
ユーザーがこの内容について質問しているので、的確に答えてください。
小説とレビューをふまえた上で、自然でフレンドリーな語り口で、簡潔に（1〜3文）で返答してください。

【小説】:
${state.buffer}

【レビュー内容】:
${state.lastReview}

【質問】:
${message}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }]
      });

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: completion.choices[0].message.content.trim(),
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } }
          ]
        }
      });
    } catch (err) {
      console.error(err);
      return client.replyMessage(event.replyToken, { type: 'text', text: '質問に答えるときにエラーが出たみたい。' });
    }
  }
}

async function generateAndSendReview(userId, userName) {
  const state = userStates[userId];
  if (!state || !state.buffer) {
    return client.pushMessage(userId, { type: 'text', text: 'レビューできる内容が見つからなかったよ。最初からリセットしてね。' });
  }

  const prompt = `以下は${userName}さんの小説です。ジャンル: ${state.genre}、レビューのレベル: ${state.level}。

あなたは読書好きで、フレンドリーだけど鋭い視点を持った読者です。
感想の冒頭は、作品を読んだ率直な一言から始め、そのあとに【良かった点】【改善点】【全体について】をそれぞれ3点ずつ簡潔に、重複せず記述してください。
文章は500〜600字程度にまとめ、感想は読者目線でキャラクターやストーリーに言及しつつ、自分の好みや感じたことを率直に述べてください。
口調はフレンドリーながらも、内容はプロの書評家のような鋭さを意識してください。
最後は必ずポジティブな一言で締めくくってください。

---

${state.buffer}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }]
    });

    const fullText = completion.choices[0].message.content;
    state.step = 'review_done';
    state.lastReview = fullText;

    const messages = fullText.match(/([\s\S]{1,1900})(?=\n|$)/g);
    for (const msg of messages) {
      await client.pushMessage(userId, { type: 'text', text: msg.trim() });
    }

    await client.pushMessage(userId, {
      type: 'text',
      text: '質問があれば、何でも聞いてね！\n最初からやり直す場合は、「リセット」を選択してね。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } }
        ]
      }
    });
  } catch (err) {
    console.error(err);
    await client.pushMessage(userId, {
      type: 'text',
      text: 'レビュー中にエラーが出たか、文字数が多すぎたかも！'
    });
  }
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
