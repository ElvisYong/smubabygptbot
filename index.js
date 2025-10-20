import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const {
  OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;
const TG = (m) => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${m}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const state = new Map();
const log = (...args) => console.log("[BabyGPT]", ...args);

// ------------------- helpers -------------------
async function safeFetch(url, opts = {}, label = "fetch") {
  try {
    log(`→ ${label}: ${url}`);
    const res = await fetch(url, opts);
    const text = await res.text();
    log(`← ${label}: ${res.status}`, text.slice(0, 120));
    return res.ok ? JSON.parse(text) : null;
  } catch (err) {
    log(`⚠️ ${label} failed:`, err.message);
    return null;
  }
}

async function sendMsg(chat_id, text, keyboard, label = "sendMessage") {
  return safeFetch(
    TG("sendMessage"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
        reply_markup: keyboard,
      }),
    },
    label
  );
}

// ------------------- intent logic -------------------
const EMERGENCY_RE =
  /(blue lips|not ?breathing|unresponsive|seizure|fever\s?(?:40|4[01]))/i;
const OFFLIMIT_RE =
  /(self[- ]harm|suicide|sexual|violence|illegal|loan|money lending)/i;

const ruleIntent = (t) => {
  const s = t.toLowerCase();
  if (/cry|sleep|colic/.test(s)) return "healthdev.crying_sleep";
  if (/solid|wean|milk|feed|diet|meal/.test(s)) return "healthdev.nutrition";
  if (/infantcare|preschool|nanny/.test(s)) return "caregiving.find";
  if (/helper|mdw|maid|permit/.test(s)) return "caregiving.helper";
  if (/conflicting|too many opinions/.test(s)) return "advice.conflict";
  return "unknown";
};

// 🧩 wrap OpenAI calls to trap quota / network errors
async function callOpenAI(fn, label) {
  try {
    return await fn();
  } catch (err) {
    const msg = err?.error?.message || err.message || "unknown error";
    log(`⚠️ OpenAI ${label} failed:`, msg);
    if (
      msg.includes("insufficient_quota") ||
      msg.includes("billing_hard_limit") ||
      msg.includes("You exceeded")
    ) {
      throw new Error("openai_quota");
    }
    throw err;
  }
}

// ------------------- AI functions -------------------
async function classifyIntentLLM(text) {
  log("→ classifyIntentLLM", text);
  return callOpenAI(async () => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "IntentClassification",
          schema: {
            type: "object",
            properties: {
              intent: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["intent", "confidence"],
          },
        },
      },
      messages: [
        {
          role: "system",
          content: "Classify one intent. Emergencies -> escalation.emergency",
        },
        { role: "user", content: text },
      ],
    });
    const parsed = JSON.parse(r.choices[0].message.content);
    log("← classifyIntentLLM", parsed);
    return parsed;
  }, "classifyIntentLLM");
}

async function composeAI(intent, text) {
  log("→ composeAI", intent, text);
  return callOpenAI(async () => {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are BabyGPT (SG). Step-based guidance only. ≤180 words. Emergencies → 995.",
        },
        { role: "user", content: text },
      ],
    });
    return resp.choices[0].message.content.trim();
  }, "composeAI");
}

// ------------------- Telegram handlers -------------------
const keyboard = {
  inline_keyboard: [
    [{ text: "🍼 Crying / Sleep", callback_data: "flow:cry" }],
    [{ text: "🥣 Nutrition", callback_data: "flow:nutrition" }],
    [{ text: "👩‍🍼 Caregiving", callback_data: "flow:caregiver" }],
  ],
};

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body;
  log("🟢 update", JSON.stringify(upd).slice(0, 200));

  try {
    if (upd.message?.text) {
      const chatId = upd.message.chat.id;
      const text = upd.message.text.trim();
      log(`📩 from ${chatId}:`, text);

      if (text === "/start") {
        await sendMsg(chatId, "Hi! I’m BabyGPT 👶 (SG).", keyboard);
        return;
      }

      if (EMERGENCY_RE.test(text))
        return sendMsg(chatId, "⚠️ Emergency, call 995.", keyboard);
      if (OFFLIMIT_RE.test(text))
        return sendMsg(
          chatId,
          "Sorry, cannot assist with that topic.",
          keyboard
        );

      let intent = ruleIntent(text);
      log("🔍 regex intent:", intent);
      if (intent === "unknown") {
        try {
          const { intent: i } = await classifyIntentLLM(text);
          intent = i;
        } catch (err) {
          if (err.message === "openai_quota") {
            await sendMsg(
              chatId,
              "[debug] OpenAI API quota exceeded – please check API credits.",
              keyboard
            );
            return;
          }
          throw err;
        }
      }
      log("🎯 final intent:", intent);

      try {
        const out = await composeAI(intent, text);
        await sendMsg(chatId, out, keyboard);
      } catch (err) {
        if (err.message === "openai_quota") {
          await sendMsg(
            chatId,
            "[debug] OpenAI API quota exceeded – please check API credits.",
            keyboard
          );
          return;
        }
        throw err;
      }
    }
  } catch (err) {
    log("🔥 webhook error", err.message);
    await sendMsg(
      upd.message?.chat?.id,
      `[debug] Internal error: ${err.message}`
    );
  }
});

// ------------------- health + webhook setup -------------------
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, async () => {
  log(`🚀 BabyGPT on :${PORT}`);
  if (PUBLIC_URL && TELEGRAM_BOT_TOKEN) {
    const url = `${PUBLIC_URL}/telegram/webhook`;
    await safeFetch(
      TG("setWebhook") + `?url=${encodeURIComponent(url)}`,
      {},
      "setWebhook"
    );
  }
});
