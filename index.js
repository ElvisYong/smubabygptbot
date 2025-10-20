// index.js (ESM, Node 18+)
// npm i express openai dotenv
import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// ───────────────────────── Config & Clients ─────────────────────────
const {
  OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;
const TG = (m) => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${m}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const log = (...a) => console.log("[BabyGPT]", ...a);

// per-chat memory (for chosen “flow”)
const state = new Map(); // chat_id -> { flow?: 'cry'|'nutrition'|'caregiver'|'advice' }

// ─────────────────────── Safety & Intent Rules ──────────────────────
const EMERGENCY_RE =
  /(blue lips|not ?breathing|unresponsive|seizure|stiff neck|bulging fontanelle|fever\s?(?:40|4[01])|difficulty breathing)/i;
const OFFLIMIT_RE =
  /(self[- ]harm|suicide|sexual|violence|illegal|loan|money lending)/i;

const ruleIntent = (t) => {
  const s = t.toLowerCase();
  if (/cry|sleep|colic|night waking|won'?t sleep/.test(s))
    return "healthdev.crying_sleep";
  if (/solid|wean|milk|feed|recipe|diet|meal/.test(s))
    return "healthdev.nutrition";
  if (/milestone|tummy|speech|development/.test(s))
    return "healthdev.milestones";
  if (/infantcare|preschool|nanny|babysitter|daycare/.test(s))
    return "caregiving.find";
  if (/helper|mdw|maid|work permit|permit/.test(s)) return "caregiving.helper";
  if (/conflicting|too many opinions|overload/.test(s))
    return "advice.conflict";
  if (/overwhelmed|anxious|tired|burnt\s?out/.test(s))
    return "wellbeing.checkin";
  if (/help|menu/.test(s)) return "help.anytime";
  return "unknown";
};

// ─────────────────────── Helpers: HTTP & Telegram ───────────────────
async function safeFetch(url, opts = {}, label = "fetch") {
  try {
    log(`→ ${label}: ${url}`);
    const res = await fetch(url, opts);
    const text = await res.text();
    log(`← ${label}: ${res.status} ${text.slice(0, 200)}`);
    return res.ok ? JSON.parse(text) : null;
  } catch (err) {
    log(`⚠️ ${label} failed:`, err.message);
    return null;
  }
}

const sendMsg = (chat_id, text, keyboard, label = "sendMessage") =>
  safeFetch(
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

const answerCbq = (id, label = "answerCallbackQuery") =>
  safeFetch(
    TG("answerCallbackQuery"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id }),
    },
    label
  );

// ───────────────────── SG “More information” links ──────────────────
const SG_LINKS = {
  "healthdev.crying_sleep": [
    "HealthHub (Sleep Basics): https://www.healthhub.sg/live-healthy/1637/baby_sleep_basics",
    "KKH Baby Sleep Guide: https://www.kkh.com.sg/healtharticles/baby-sleep-basics",
  ],
  "healthdev.nutrition": [
    "HealthHub (Healthy Diet 0–3): https://www.healthhub.sg/programmes/parent-hub/baby-toddler/childhood-healthy-diet",
    "HPB Recipes: https://www.healthhub.sg/programmes/parent-hub/recipes",
  ],
  "healthdev.milestones": [
    "KKH Developmental Milestones: https://www.kkh.com.sg/healtharticles/developmental-milestones",
  ],
  "caregiving.find": [
    "ECDA Preschool / Infantcare Search: https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx",
    "LifeSG Preschool Services: https://www.life.gov.sg/services/parenting/preschool",
  ],
  "caregiving.helper": [
    "MOM Work Permit (MDW): https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker",
    "Apply for MDW Permit: https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker/apply",
  ],
  "advice.conflict": [
    "Families for Life (Parenting): https://familiesforlife.sg/parenting",
    "HealthHub Parenting Tips: https://www.healthhub.sg/live-healthy/1144/mental_health_tips_for_parents",
  ],
  "wellbeing.checkin": [
    "IMH Helpline (24h): 6389 2222",
    "SOS (Samaritans of SG): 1767",
  ],
};

// ───────────── Static blocks used for instant deterministic replies ──────────
const blockInfantcare = () =>
  `Steps to find infantcare (SG):
1) Use ECDA/LifeSG to shortlist by location, hours, fees.
2) Visit 2–3 centres: hygiene, caregiver interaction, routine.
3) Join waitlist; ask about subsidies & transition.
*More information:*
• ECDA: https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx
• LifeSG: https://www.life.gov.sg/services/parenting/preschool
\n_Disclaimer: General info only. For emergencies, call 995._`;

const blockHelper = () =>
  `Hire a helper (MDW) in SG:
1) Check MOM eligibility; agency vs direct-hire.
2) Interview; verify experience; define duties in writing.
3) Insurance; IPA → arrival → permit & orientation.
*More information:*
• MOM Work Permit (MDW): https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker
• Apply: https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker/apply
\n_Disclaimer: General info only. For emergencies, call 995._`;

// ─────────────── OpenAI wrappers (quota → [debug] message) ───────────────
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
    )
      throw new Error("openai_quota");
    throw err;
  }
}

async function classifyIntentLLM(text) {
  log("→ classifyIntentLLM input:", text);
  return callOpenAI(async () => {
    const schema = {
      name: "IntentClassification",
      schema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: [
              "healthdev.crying_sleep",
              "healthdev.nutrition",
              "healthdev.milestones",
              "caregiving.find",
              "caregiving.helper",
              "advice.conflict",
              "wellbeing.checkin",
              "help.anytime",
              "escalation.emergency",
              "unknown",
            ],
          },
          confidence: { type: "number" },
        },
        required: ["intent", "confidence"],
        additionalProperties: false,
      },
    };
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [
        {
          role: "system",
          content:
            "Classify the user message into exactly one intent. Emergencies → escalation.emergency. Return JSON only.",
        },
        { role: "user", content: text },
      ],
    });
    const parsed = JSON.parse(r.choices[0].message.content);
    log("← classifyIntentLLM result:", parsed);
    return parsed;
  }, "classifyIntentLLM");
}

async function composeAI(intent, text, baseSteps = "") {
  log("→ composeAI intent:", intent, "| text:", text);
  return callOpenAI(async () => {
    const system = `You are BabyGPT (Singapore). Provide step-by-step guidance first, then one friendly sentence. ≤180 words.
No diagnosis. Emergencies → call 995. Prefer SG official resources. Intent: ${intent}`;

    const user = `User: ${text}
Base steps (may be empty):
${baseSteps}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    let out =
      resp.choices[0].message.content?.trim() ||
      "Let’s take this step by step.";

    // Append “More information” links automatically
    const refs = SG_LINKS[intent] || [];
    if (refs.length) {
      out += "\n\n*More information:*\n" + refs.map((x) => `• ${x}`).join("\n");
    }
    return (
      out + "\n\n_Disclaimer: General info only. For emergencies, call 995._"
    );
  }, "composeAI");
}

// ─────────────────────────── Telegram UI ────────────────────────────
const keyboard = {
  inline_keyboard: [
    [{ text: "🍼 Crying / Sleep", callback_data: "flow:cry" }],
    [{ text: "🥣 Nutrition", callback_data: "flow:nutrition" }],
    [{ text: "👩‍🍼 Caregiving", callback_data: "flow:caregiver" }],
    [{ text: "🧭 Conflicting Advice", callback_data: "flow:advice" }],
  ],
};

// ─────────────────────────── Webhook Handler ─────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body;

  const type = upd.callback_query
    ? "callback_query"
    : upd.message
    ? "message"
    : upd.edited_message
    ? "edited_message"
    : "unknown";
  log("🟢 update type:", type);
  log("🧾 update raw:", JSON.stringify(upd).slice(0, 1200));

  try {
    // 1) Inline button taps
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data || "";
      log("🧲 callback_query payload:", { chatId, data });

      await answerCbq(cq.id); // ACK to stop spinner

      if (data.startsWith("flow:")) {
        const flow = data.split(":")[1]; // cry|nutrition|caregiver|advice
        state.set(chatId, { flow });
        log(`💬 set flow=${flow} for chat ${chatId}`);

        const promptMap = {
          cry: "Tell me the crying/sleep details (age + when it happens).",
          nutrition:
            "Ask about feeding (milk amounts, starting solids, meal ideas).",
          caregiver:
            "What caregiver do you need? (infantcare, helper/MDW, nanny/babysitter) and area?",
          advice:
            "What conflicting advice are you getting? I’ll help you pick a plan.",
        };
        const breadcrumb = `\n\n_Current topic: ${flow.toUpperCase()} • tap another button to change._`;
        await sendMsg(
          chatId,
          `${promptMap[flow]}${breadcrumb}`,
          { inline_keyboard: keyboard.inline_keyboard },
          "sendMessage(prompt-after-flow)"
        );
      }
      return;
    }

    // 2) Messages
    const m = upd.message || upd.edited_message;
    if (!m?.text) return;
    const chatId = m.chat.id;
    const text = m.text.trim();
    log(`📩 msg from ${chatId}:`, text);

    // Map reply-keyboard texts (in case some clients send label text)
    if (/^\s*🍼?\s*Crying\s*\/\s*Sleep\s*$/i.test(text))
      state.set(chatId, { flow: "cry" });
    if (/^\s*🥣?\s*Nutrition\s*$/i.test(text))
      state.set(chatId, { flow: "nutrition" });
    if (/^\s*👩‍🍼?\s*Caregiving\s*$/i.test(text))
      state.set(chatId, { flow: "caregiver" });
    if (/Conflicting.*Advice/i.test(text))
      state.set(chatId, { flow: "advice" });

    // /start intro
    if (text === "/start") {
      state.delete(chatId);
      const intro = `
👶 *Hi, I'm BabyGPT (Singapore Edition)!*
Your friendly companion for first-time parents of babies aged 0–3.

I can help with:
1️⃣ *Health & Development* — sleep/crying, feeding & nutrition, milestones  
2️⃣ *Caregiving Support* — infantcare & nanny/helper info, and resolving conflicting advice  
3️⃣ *Parental Wellbeing* — gentle pointers for self-care

I’m not a medical professional, but I’ll summarise steps and include trusted SG resources like HealthHub, ECDA, MOM.

*What would you like help with today?* 👇
      `;
      await sendMsg(
        chatId,
        intro.trim(),
        { inline_keyboard: keyboard.inline_keyboard },
        "sendMessage(/start)"
      );
      return;
    }

    // Safety
    if (EMERGENCY_RE.test(text)) {
      await sendMsg(
        chatId,
        "⚠️ This may be urgent. Please call 995 or go to the nearest A&E now.",
        { inline_keyboard: keyboard.inline_keyboard }
      );
      return;
    }
    if (OFFLIMIT_RE.test(text)) {
      await sendMsg(
        chatId,
        "Sorry, I can’t assist with that topic. If you feel unsafe, call SOS (1767) or IMH (6389 2222).",
        { inline_keyboard: keyboard.inline_keyboard }
      );
      return;
    }

    // Intent detection (regex → LLM fallback)
    let intent = ruleIntent(text);
    log("🔍 regex intent:", intent);
    if (intent === "unknown") {
      try {
        const { intent: li } = await classifyIntentLLM(text);
        intent = li;
      } catch (err) {
        if (err.message === "openai_quota") {
          await sendMsg(
            chatId,
            "[debug] OpenAI API quota exceeded – please check API credits.",
            { inline_keyboard: keyboard.inline_keyboard }
          );
          return;
        }
        throw err;
      }
    }

    // Respect currently selected flow
    const flow = state.get(chatId)?.flow;
    if (flow) log(`💾 active flow=${flow}`);
    if (flow === "cry") intent = "healthdev.crying_sleep";
    if (flow === "nutrition") intent = "healthdev.nutrition";
    if (flow === "caregiver")
      intent = /(helper|mdw|maid|permit)/i.test(text)
        ? "caregiving.helper"
        : "caregiving.find";
    if (flow === "advice") intent = "advice.conflict";
    log("🎯 final intent:", intent, "| input:", text);

    // Route
    if (intent === "caregiving.find") {
      await sendMsg(chatId, blockInfantcare(), {
        inline_keyboard: keyboard.inline_keyboard,
      });
      return;
    }
    if (intent === "caregiving.helper") {
      await sendMsg(chatId, blockHelper(), {
        inline_keyboard: keyboard.inline_keyboard,
      });
      return;
    }

    const base =
      intent === "healthdev.nutrition"
        ? "0–6m: milk on demand; 6–12m: start solids (iron-rich daily, one new food at a time); >12m: family meals; avoid choking."
        : intent === "healthdev.crying_sleep"
        ? "Soothing: feed → burp 5–10 min → swaddle + white noise → dim lights. Keep age-appropriate wake windows."
        : intent === "advice.conflict"
        ? "Resolver: 1) Prefer HealthHub guidance 2) Pick one approach that fits family 3) Try for 3–5 days, then review."
        : intent === "healthdev.milestones"
        ? "Steady progress: motor (tummy time), language (babble→words), social (smiles→joint attention). See GP if worried."
        : intent === "wellbeing.checkin"
        ? "2–5 min reset: box breathing 4-4-4-4; choose one tiny win for today; ask for help when needed."
        : "";

    try {
      const out = await composeAI(intent, text, base);
      await sendMsg(chatId, out, { inline_keyboard: keyboard.inline_keyboard });
    } catch (err) {
      if (err.message === "openai_quota") {
        await sendMsg(
          chatId,
          "[debug] OpenAI API quota exceeded – please check API credits.",
          { inline_keyboard: keyboard.inline_keyboard }
        );
        return;
      }
      throw err;
    }
  } catch (err) {
    log("🔥 webhook handler error:", err);
  }
});

// ───────────────────────── Health & Webhook setup ───────────────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, async () => {
  log(`🚀 BabyGPT server on :${PORT}`);
  if (PUBLIC_URL && TELEGRAM_BOT_TOKEN) {
    const payload = {
      url: `${PUBLIC_URL}/telegram/webhook`,
      allowed_updates: ["message", "callback_query", "edited_message"],
    };
    await safeFetch(
      TG("setWebhook"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      "setWebhook"
    );
  } else {
    log("⚠️ PUBLIC_URL or TELEGRAM_BOT_TOKEN missing; webhook not configured.");
  }
});
