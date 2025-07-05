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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const userStates = {};

const genres = [
  "異世界ファンタジー", "現代ファンタジー", "SF", "恋愛", "ラブコメ",
  "現代ドラマ", "ホラー", "ミステリー", "エッセイ・ノンフィクション",
  "歴史・時代系", "詩・童話", "その他"
];

const aspects = [
  "ストーリー", "キャラクター", "構成", "文章", "総合"
];

const levels = ["甘口", "中辛", "辛口"];

const MAX_TOKENS = 128000;
const MAX_CHARACTERS = 30000;

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

  if (event.type !== 'message' || event.message.type !== 'text') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ごめんなさい、画像やスタンプ等は解析できないんです…',
    });
  }

  const message = event.message.text;
  if (!userStates[userId]) {
    userStates[userId] = { step: 'genre' };
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ジャンルを選んでください：',
      quickReply: {
        items: genres.map(g => ({
          type: 'action',
          action: { type: 'message', label: g, text: g }
        }))
      }
    });
  }

  const state = userStates[userId];

  if (state.step === 'genre') {
    if (!genres.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ボタンを選択してください：',
        quickReply: {
          items: genres.map(g => ({
            type: 'action',
            action: { type: 'message', label: g, text: g }
          }))
        }
      });
    }
    state.genre = message;
    state.step = 'level';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'レビューのレベルを選んでください：',
      quickReply: {
        items: levels.map(l => ({
          type: 'action',
          action: { type: 'message', label: l, text: l }
        }))
      }
    });
  }

  if (state.step === 'level') {
    if (!levels.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ボタンを選択してください：',
        quickReply: {
          items: levels.map(l => ({
            type: 'action',
            action: { type: 'message', label: l, text: l }
          }))
        }
      });
    }
    state.level = message;
    state.step = 'aspect';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'レビューの観点を選んでください：',
      quickReply: {
        items: aspects.map(a => ({
          type: 'action',
          action: { type: 'message', label: a, text: a }
        }))
      }
    });
  }

  if (state.step === 'aspect') {
    if (!aspects.includes(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ボタンを選択してください：',
        quickReply: {
          items: aspects.map(a => ({
            type: 'action',
            action: { type: 'message', label: a, text: a }
          }))
        }
      });
    }
    state.aspect = message;
    state.step = 'awaiting_text';
    state.buffer = "";
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'あなたの小説を送ってください（1000字以上）。',
    });
  }

  if (state.step === 'awaiting_text' || state.step === 'awaiting_additional_text') {
    if (!state.buffer) state.buffer = "";
    state.buffer += '\n' + message;

    if (state.step === 'awaiting_text' && state.buffer.length < 1000) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '1000字以上で送信するようにしてください。',
      });
    }

    if (state.buffer.length > MAX_CHARACTERS) {
      state.step = 'confirm_review_overflow';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '最大文字数を超えたため、これ以上送れません。このままレビューしてもよろしいですか？',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: 'はい', text: 'レビューしてください' } },
            { type: 'action', action: { type: 'message', label: 'いいえ', text: 'キャンセル' } },
          ]
        }
      });
    }

    state.step = 'awaiting_continue_confirm';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '続きはありますか？',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
        ]
      }
    });
  }

  if (state.step === 'confirm_review_overflow') {
    if (message === 'レビューしてください') {
      return generateAndSendReview(userId, event.replyToken);
    } else if (message === 'キャンセル') {
      userStates[userId] = null;
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'キャンセルされました。最初からやり直してください。'
      });
    }
  }

  if (state.step === 'awaiting_continue_confirm') {
    if (message === 'はい') {
      state.step = 'awaiting_additional_text';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '続きを送ってください。',
      });
    }
    if (message === 'いいえ') {
      return generateAndSendReview(userId, event.replyToken);
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '「はい」か「いいえ」で答えてください。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
        ]
      }
    });
  }
}

async function generateAndSendReview(userId, replyToken) {
  const state = userStates[userId];
  const prompt = `以下はユーザーの小説です。
ジャンル: ${state.genre}
観点: ${state.aspect}
レビューのレベル: ${state.level}

あなたは小説の読者です。
レビューのレベル「${state.level}」に応じてトーンを調整してください。

次のフォーマットでレビューしてください：

【総合評価】
0.0〜5.0の50段階評価で数値を出し、★の形でも視覚的に示してください。

【各項目の評価】
- ストーリー：◯◯点
- キャラクター：◯◯点
- 構成：◯◯点
- 文章：◯◯点
- オリジナリティ：◯◯点

【良かった点】
2〜4個、箇条書き。

【改善点】
2〜4個、箇条書き。

---

【${state.aspect}について】
この観点における表現や描写について、丁寧に講評してください。

---

${state.buffer}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: "user", content: prompt }],
    });

    const fullText = completion.choices[0].message.content;
    userStates[userId] = null;
    const messages = fullText.match(/([\s\S]{1,1900})(?=\n|$)/g);

    if (!messages || messages.length === 0) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'レビューの生成に失敗しました。もう一度お試しください。',
      });
    }

    await client.replyMessage(replyToken, {
      type: 'text',
      text: messages[0].trim(),
    });

    for (let i = 1; i < messages.length; i++) {
      await client.pushMessage(userId, {
        type: 'text',
        text: messages[i].trim(),
      });
    }
  } catch (err) {
    console.error(err);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: 'レビューの生成中にエラーが発生しました。文章が長すぎる可能性があります。',
    });
  }
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
