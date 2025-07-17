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

const aspects = ["ストーリー", "キャラクター", "構成", "文章", "総合"];
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

  const addResetButton = (items) => {
    items.push({
      type: 'action',
      action: { type: 'message', label: 'リセット', text: 'リセット' }
    });
    return items;
  };

  const stepHandlers = {
    genre: () => handleSelection(event, genres, 'level', 'レビューのレベルを選んでください：', levels),
    level: () => handleSelection(event, levels, 'aspect', 'レビューの観点を選んでください：', aspects),
    aspect: () => handleSelection(event, aspects, 'awaiting_text', 'あなたの小説を送ってください（1000字以上）。'),
  };

  if (stepHandlers[state.step]) return stepHandlers[state.step]();

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
        quickReply: { items: addResetButton([
          { type: 'action', action: { type: 'message', label: 'はい', text: 'レビューしてください' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'キャンセル' } },
        ]) }
      });
    }

    state.step = 'awaiting_continue_confirm';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '続きはありますか？',
      quickReply: {
        items: addResetButton([
          { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
        ])
      }
    });
  }

  if (state.step === 'confirm_review_overflow' && message === 'レビューしてください') {
    return generateAndSendReview(userId);
  }

  if (state.step === 'awaiting_continue_confirm') {
    if (message === 'はい') {
      state.step = 'awaiting_additional_text';
      return client.replyMessage(event.replyToken, { type: 'text', text: '続きを送ってください。' });
    }
    if (message === 'いいえ') {
      state.step = 'generating_review';
      await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！ 読ませてもらうね🌟' });
      setTimeout(() => generateAndSendReview(userId), 800);
      return;
    }
  }

  if (state.step === 'review_done') {
    if (/リセット/.test(message)) {
      userStates[userId] = { step: 'genre' };
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ジャンルを選んでください：',
        quickReply: {
          items: genres.map(g => ({ type: 'action', action: { type: 'message', label: g, text: g } }))
        }
      });
    }

    if (message.length > 5 && /作品|レビュー/.test(message)) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'いい質問だね！それについて話すね！(まだ質問への具体回答処理は未実装)',
        quickReply: {
          items: [{ type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } }]
        }
      });
    } else {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '作品やレビューに関する質問をしてね！',
        quickReply: {
          items: [{ type: 'action', action: { type: 'message', label: 'リセット', text: 'リセット' } }]
        }
      });
    }
  }
}

function handleSelection(event, list, nextStep, prompt, nextList) {
  const state = userStates[event.source.userId];
  const message = event.message.text;
  if (!list.includes(message)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ボタンを選択してください：',
      quickReply: { items: addResetButton(list.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } }))) }
    });
  }
  state[state.step] = message;
  state.step = nextStep;
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: prompt,
    quickReply: nextList ? { items: addResetButton(nextList.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } }))) } : undefined
  });
}

async function generateAndSendReview(userId) {
  const state = userStates[userId];
  if (!state || !state.buffer) {
    return client.pushMessage(userId, {
      type: 'text',
      text: 'レビュー内容が見つかりません。最初からやり直してください。'
    });
  }

  const prompt = `以下はユーザーの小説です。\nジャンル: ${state.genre}\n観点: ${state.aspect}\nレビューのレベル: ${state.level}\n\nあなたは友達に話しかけるような、かわいらしい男の子のキャラクターです。\n敬語は使わず、親しみやすいフランクな口調で、しっかり読んで感想を伝えてください。\nときには主観や好みも交えてOKですが、最終的には相手の創作意欲が湧くように応援してください。\n\n次のフォーマットでレビューしてください：\n\n【総合評価】\n0.0〜5.0の50段階評価で数値を出し、★の形でも視覚的に示してね。\n\n【各項目の評価】\n- ストーリー：◯◯点\n- キャラクター：◯◯点\n- 構成：◯◯点\n- 文章：◯◯点\n- オリジナリティ：◯◯点\n※各項目は0.0〜5.0の範囲に収めてください。\n\n【良かった点】\n箇条書きで3つ。小説の具体的な魅力を挙げてね。\n\n【改善点】\n箇条書きで3つ。具体的な提案にしてね。\n\n---\n\n【${state.aspect}について】\nこの観点について、500〜600字くらいで講評してね。\nキャラやストーリーへの言及を入れつつ、自分の感じたことや好みも交えて話していいよ。\n最後はポジティブに、応援の気持ちで締めてあげてね。\n\n---\n\n${state.buffer}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
    });

    const fullText = completion.choices[0].message.content;
    state.step = 'review_done';
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
      text: 'レビューの生成中にエラーが出ました。文章が最大文字数をオーバーしたかもしれません。',
    });
  }
}

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
