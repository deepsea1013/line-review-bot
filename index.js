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
      text: 'ごめんなさい、画像やスタンプ等は解析できないんです…'
    });
  }

  const message = event.message.text;

  if (message === 'リセット') {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ジャンルを選んでください：',
      quickReply: { items: genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } })) }
    });
  }

  if (!userStates[userId]) {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ジャンルを選んでください：',
      quickReply: { items: genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } })) }
    });
  }

  const state = userStates[userId];

  if (state.step === 'genre') {
    if (!genres.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ボタンを選択してください：',
        quickReply: { items: addResetButton(genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } }))) }
      });
    }
    state.genre = message;
    state.step = 'level';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'レビューのレベルを選んでください：',
      quickReply: { items: addResetButton(levels.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } }))) }
    });
  }

  if (state.step === 'level') {
    state.level = message;
    state.step = 'awaiting_text';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'あなたの小説を送ってください（1000字以上）。',
      quickReply: { items: addResetButton([]) }
    });
  }

  if (state.step === 'awaiting_text' || state.step === 'awaiting_additional_text') {
    if (!state.buffer) state.buffer = "";
    state.buffer += '\n' + message;

    if (state.step === 'awaiting_text' && state.buffer.length < 1000) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '1000字以上で送信するようにしてください。' });
    }

    if (state.buffer.length > MAX_CHARACTERS) {
      state.step = 'confirm_review_overflow';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '最大文字数を超えたため、これ以上送れません。このままレビューしてもよろしいですか？',
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
      text: '続きはありますか？',
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
      return client.replyMessage(event.replyToken, { type: 'text', text: '続きを送ってください。' });
    }
    if (message === 'いいえ') {
      state.step = 'generating_review';
      await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！ 読ませてもらうね🌟' });
      setTimeout(() => generateAndSendReview(userId, userName), 800);
      return;
    }
  }

  if (state.step === 'review_done') {
    const prompt = `以下は${userName}さんの作品です。そのレビュー結果に関してユーザーが質問しています。
ユーザーの質問: ${message}
以下のレビュー内容に即して、誠実かつ具体的に回答してください。

---

${state.lastReview}

---`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }]
      });

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: completion.choices[0].message.content,
        quickReply: { items: [ { type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } } ] }
      });
    } catch (err) {
      console.error(err);
      return client.replyMessage(event.replyToken, { type: 'text', text: '質問の処理中にエラーが発生しました。' });
    }
  }
}

async function generateAndSendReview(userId, userName) {
  const state = userStates[userId];
  if (!state || !state.buffer) {
    return client.pushMessage(userId, { type: 'text', text: 'レビュー内容が見つかりません。最初からやり直してください。' });
  }

  const prompt = `以下は${userName}さんの小説です。ジャンル: ${state.genre}、レビューのレベル: ${state.level}。

あなたは書評家のように鋭く、小説の構造やテーマを解釈するスキルを持った、フレンドリーな語り口のキャラクターです。
レビューは以下の形式で、重複を避け簡潔に。甘口＝やさしめ、中辛＝中立、辛口＝厳しめの評価にしてください。
ユーザーのことは「${userName}さん」と呼んでください。

【総合評価】
0.0〜5.0の50段階評価で数値と★を視覚的に表示

【各項目の評価】
- ストーリー：0.0〜5.0点
- キャラクター：0.0〜5.0点
- 構成：0.0〜5.0点
- 文章：0.0〜5.0点
- オリジナリティ：0.0〜5.0点

【良かった点】（3つ、簡潔に、重複なし）
【改善点】（3つ、提案型、簡潔に、重複なし）

【全体について】（500〜600字、キャラやストーリーに触れつつ構造やテーマの深掘りあり、ポジティブに締める）

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
      quickReply: { items: [ { type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } } ] }
    });
  } catch (err) {
    console.error(err);
    await client.pushMessage(userId, {
      type: 'text',
      text: 'レビュー生成中にエラーが発生しました。文字数が多すぎる可能性があります。'
    });
  }
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
