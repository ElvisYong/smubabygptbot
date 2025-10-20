import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// --- Config & Clients --------------------------------------------------------
const {
  OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;
const TG = (m) => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${m}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Safety & Intent ---------------------------------------------------------
const EMERGENCY_RE =
  /(blue lips|not ?breathing|unresponsive|seizure|stiff neck|bulging fontanelle|fever\s?(?:40|4[01])|difficulty breathing)/i;
const OFFLIMIT_RE =
  /(self[- ]harm|suicide|sexual|violence|illegal|loan|money lending)/i;

const ruleIntent = (t) => {
  const s = t.toLowerCase();
  if (/(cry|sleep|colic|night waking|won'?t sleep)/i.test(s))
    return "healthdev.crying_sleep";
  if (/(solid|wean|milk|feed|recipe|diet|meal)/i.test(s))
    return "healthdev.nutrition";
  if (/(milestone|tummy|speech|development)/i.test(s))
    return "healthdev.milestones";
  if (/(infantcare|preschool|nanny|babysitter|daycare)/i.test(s))
    return "caregiving.find";
  if (/(helper|mdw|maid|work permit)/i.test(s)) return "caregiving.helper";
  if (/(conflicting|too many opinions|overload)/i.test(s))
    return "advice.conflict";
  if (/(overwhelmed|anxious|tired|burnt\s?out)/i.test(s))
    return "wellbeing.checkin";
  if (/(help|menu)/i.test(s)) return "help.anytime";
  return "unknown";
};

async function classifyIntentLLM(text) {
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
          "Classify into exactly one intent from enum. If emergency cues (blue lips, not breathing, seizure, fever 40/41) → escalation.emergency. Return JSON only.",
      },
      { role: "user", content: text },
    ],
  });
  return JSON.parse(r.choices[0].message.content);
}

// --- SG links & concise static blocks ----------------------------------------
const SG = {
  diet: "https://www.healthhub.sg/programmes/parent-hub/baby-toddler/childhood-healthy-diet",
  recipes: "https://www.healthhub.sg/programmes/parent-hub/recipes",
  ecda: "https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx",
  lifesg: "https://www.life.gov.sg/services/parenting/preschool",
  mdwReq:
    "https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker/eligibility-and-requirements",
  mdwApply:
    "https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker/apply",
};

const blockInfantcare = () =>
  `Steps to find infantcare (SG):
1) Use ECDA/LifeSG to shortlist by location, hours, fees.
2) Visit 2–3 centres: hygiene, caregiver interaction, routine.
3) Join waitlist; ask about subsidies & transition.
Links:
• ECDA: ${SG.ecda}
• LifeSG: ${SG.lifesg}`;

const blockHelper = () =>
  `Hire a helper (MDW) in SG:
1) Check MOM eligibility; agency vs direct-hire.
2) Interview; verify experience; define duties in writing.
3) Insurance; IPA → arrival → permit & orientation.
Links:
• MOM Requirements: ${SG.mdwReq}
• Apply Work Permit: ${SG.mdwApply}`;

// --- AI composer (step-first + empathy, with moderation) ---------------------
async function composeAI(intent, userText, baseSteps = "") {
  const system = `You are BabyGPT (Singapore). Provide step-by-step guidance first, then one friendly sentence.
Never diagnose. Emergencies → call 995. ≤180 words.
Prefer SG official links only (healthhub.sg, lifesg.gov.sg, mom.gov.sg, ecda.gov.sg).
Intent: ${intent}`;
  const u = `User: ${userText}
Base steps:
${baseSteps}

Helpful links:
- HealthHub: ${SG.diet}
- Recipes: ${SG.recipes}
- ECDA: ${SG.ecda}
- LifeSG: ${SG.lifesg}
- MOM MDW: ${SG.mdwReq}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: u },
    ],
  });

  let out = (resp.choices[0].message.content || "").trim();

  const mod = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: out,
  });
  if (mod.results[0].flagged)
    out =
      "⚠️ Let’s keep this safe. I can share general parenting guidance and official SG resources.";

  return (
    out + "\n\n_Disclaimer: General info only. For emergencies, call 995._"
  );
}

// --- Telegram helpers --------------------------------------------------------
const send = (chat_id, text, keyboard) =>
  fetch(TG("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id,
      text,
      disable_web_page_preview: false,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });

const keyboard = {
  inline_keyboard: [
    [{ text: "🍼 Crying / Sleep", callback_data: "flow:cry" }],
    [{ text: "🥣 Nutrition", callback_data: "flow:nutrition" }],
    [{ text: "👩‍🍼 Caregiving", callback_data: "flow:caregiver" }],
    [{ text: "🧭 Conflicting Advice", callback_data: "flow:advice" }],
  ],
};

const flowState = new Map(); // chat_id -> { flow?: 'cry'|'nutrition'|'caregiver'|'advice' }

// --- Webhook -----------------------------------------------------------------
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200); // ack fast
  try {
    const upd = req.body;

    // Buttons
    if (upd.callback_query) {
      const chatId = upd.callback_query.message.chat.id;
      const data = upd.callback_query.data;
      if (data.startsWith("flow:")) {
        const flow = data.split(":")[1];
        flowState.set(chatId, { flow });
        const prompt = {
          cry: "Share crying/sleep details (age + when it happens).",
          nutrition:
            "Ask about feeding (milk amounts, starting solids, meal ideas).",
          caregiver:
            "What caregiver? (infantcare, helper/MDW, nanny) & which area?",
          advice:
            "What conflicting advice are you getting? I’ll help you pick a plan.",
        }[flow];
        await send(
          chatId,
          `${prompt}\n\n(You can type freely; the menu is a shortcut.)`,
          { inline_keyboard: keyboard.inline_keyboard }
        );
      }
      return;
    }

    // Messages
    const m = upd.message;
    if (!m?.text) return;
    const chatId = m.chat.id;
    const text = m.text.trim();

    if (text === "/start") {
      flowState.delete(chatId);
      await send(
        chatId,
        "Hi! I’m *BabyGPT* 👶 (SG). Quick steps + official links for:\n" +
          "• Child health & development (sleep, feeding)\n" +
          "• Caregiving (infantcare, helper/MDW) & resolving conflicting advice\n\n" +
          "_I’m not medical advice — emergencies → call 995._\n\nChoose a topic or just type:",
        keyboard
      );
      return;
    }

    // Safety (input)
    if (EMERGENCY_RE.test(text)) {
      await send(
        chatId,
        "⚠️ This may be urgent. Please call 995 or go to the nearest A&E now.",
        keyboard
      );
      return;
    }
    if (OFFLIMIT_RE.test(text)) {
      await send(
        chatId,
        "Sorry, I can’t assist with that. If you feel unsafe, call SOS (1767) or IMH (6389 2222).",
        keyboard
      );
      return;
    }

    // Intent: regex → LLM fallback; respect explicit menu flow
    let intent = ruleIntent(text);
    if (intent === "unknown") {
      const { intent: llmIntent } = await classifyIntentLLM(text);
      intent = llmIntent;
    }
    const flow = flowState.get(chatId)?.flow;
    if (flow === "cry") intent = "healthdev.crying_sleep";
    if (flow === "nutrition") intent = "healthdev.nutrition";
    if (flow === "caregiver")
      intent = /(helper|mdw|maid|permit)/i.test(text)
        ? "caregiving.helper"
        : "caregiving.find";
    if (flow === "advice") intent = "advice.conflict";

    // Static blocks (instant)
    if (intent === "caregiving.find") {
      await send(
        chatId,
        blockInfantcare() +
          "\n\n_Disclaimer: General info only. For emergencies, call 995._",
        keyboard
      );
      return;
    }
    if (intent === "caregiving.helper") {
      await send(
        chatId,
        blockHelper() +
          "\n\n_Disclaimer: General info only. For emergencies, call 995._",
        keyboard
      );
      return;
    }

    // AI (step-first + empathy)
    const base =
      intent === "healthdev.nutrition"
        ? "0–6m: milk on demand; 6–12m: start solids (iron-rich daily), one new food at a time; >12m: family meals; avoid choking."
        : intent === "healthdev.crying_sleep"
        ? "Try: feed → burp 5–10 min → swaddle + white noise → dim lights. Keep age-appropriate wake windows."
        : intent === "advice.conflict"
        ? "Resolver: 1) Use HealthHub guidance 2) Pick one approach that fits family 3) Try 3–5 days, then review."
        : intent === "healthdev.milestones"
        ? "Aim for steady progress: motor (tummy time), language (babble→words), social (smiles→joint attention). Seek GP if worried."
        : intent === "wellbeing.checkin"
        ? "Do a 2–5 min reset: box breathing 4-4-4-4; reduce tonight to one tiny win; ask for help if struggling."
        : "";

    const out = await composeAI(intent, text, base);
    await send(chatId, out, keyboard);
  } catch (err) {
    console.error(err);
  }
});

// Health + webhook auto-setup
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.listen(PORT, async () => {
  console.log(`BabyGPT server on :${PORT}`);
  if (PUBLIC_URL && TELEGRAM_BOT_TOKEN) {
    const url = `${PUBLIC_URL}/telegram/webhook`;
    await fetch(TG("setWebhook") + `?url=${encodeURIComponent(url)}`);
    console.log("Webhook set to:", url);
  } else {
    console.log(
      "Set PUBLIC_URL to auto-configure webhook, or run setWebhook manually."
    );
  }
});
