// index.js — BabyGPT (Telegram) — ESM, Node 18+
// deps: npm i express openai dotenv
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

// Per-chat state
const state = new Map(); // chatId -> { flow?:string, turns?:number }

// ───────────────────────────── Safety Rails ─────────────────────────
const EMERGENCY_RE =
  /(blue lips|not ?breathing|unresponsive|seizure|stiff neck|bulging fontanelle|fever\s?(?:40|4[01])|difficulty breathing)/i;
const OFFLIMIT_RE =
  /(self[- ]harm|suicide|sexual|violence|illegal|loan|money lending)/i;

// ───────────────────── SG “More information” links ──────────────────
const SG_DEFAULT_LINKS = {
  cry: [
    "https://www.healthhub.sg/live-healthy/1637/baby_sleep_basics",
    "https://www.kkh.com.sg/healtharticles/baby-sleep-basics",
  ],
  nutrition: [
    "https://www.healthhub.sg/programmes/parent-hub/baby-toddler/childhood-healthy-diet",
    "https://www.healthhub.sg/programmes/parent-hub/recipes",
  ],
  caregiver: [
    "https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx",
    "https://www.life.gov.sg/services/parenting/preschool",
    "https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker",
  ],
  advice: [
    "https://familiesforlife.sg/parenting",
    "https://www.healthhub.sg/live-healthy/1144/mental_health_tips_for_parents",
  ],
  wellbeing: [
    "https://www.imh.com.sg/contact-us/Pages/default.aspx",
    "https://www.sos.org.sg",
  ],
};

// Allowed SG domains to keep (AI links are filtered to these)
const SG_ALLOWED_HOSTS = [
  "healthhub.sg",
  "hpb.gov.sg",
  "moh.gov.sg",
  "kkh.com.sg",
  "ecda.gov.sg",
  "life.gov.sg",
  "mom.gov.sg",
  "imh.com.sg",
  "sos.org.sg",
  "gov.sg",
];

// ───────────────── Intent Taxonomy (flows → chips) ──────────────────
const INTENTS = {
  cry: {
    label: "Crying / Sleep",
    chips: [
      { tag: "night", label: "🌙 Night waking" },
      { tag: "colic", label: "😭 Colic" },
      { tag: "naps", label: "💤 Naps" },
      { tag: "bedtime", label: "🧸 Bedtime routine" },
    ],
    patterns: {
      night: /(night|3am|midnight|every\s?night|night\s?waking)/i,
      colic: /colic|inconsolable|gas\s?pains?/i,
      naps: /\bnap(s)?\b|day\s?sleep/i,
      bedtime: /bedtime|wind.?down|routine/i,
    },
    fixed: {
      night: `Night waking basics:\n1) Feed → burp 5–10m.\n2) Dark room + white noise.\n3) Use age-appropriate wake windows.`,
      colic: `Colic relief (non-medical):\n1) Tummy-down across forearm.\n2) Bicycle legs + gentle tummy massage.\n3) White noise/rocking; brief fresh-air walk.\nSee a GP if vomiting, fever, or poor feeding.`,
      naps: `Nap tips:\n1) Watch sleepy cues (yawns, glazed look).\n2) Keep consistent nap windows.\n3) Bright mornings, dim afternoons.`,
      bedtime: `Bedtime routine (20–30m): bath → feed → story → lights out.\nAvoid screens 1h before bed; keep the same steps nightly.`,
    },
    aiPrompt: `Give stepwise soothing/sleep guidance. No diagnosis. Mention age-appropriate wake windows.`,
  },

  nutrition: {
    label: "Nutrition",
    chips: [
      { tag: "solids", label: "🥄 Start solids" },
      { tag: "milk", label: "🍼 Milk amounts" },
      { tag: "meals", label: "🍚 Meal ideas" },
      { tag: "allergy", label: "🥜 Allergies/choking" },
    ],
    patterns: {
      solids: /start(ing)?\s?solids|wean/i,
      milk: /how much.*milk|ml|oz|formula|breast/i,
      meals: /meal|menu|recipe|ideas/i,
      allergy: /allerg(y|ies)|peanut|egg|choke|choking/i,
    },
    fixed: {
      solids: `Starting solids:\n• 6–12m: begin with iron-rich foods daily; 1 new food at a time.\n• Sit upright; supervise; soft textures only.`,
      milk: `Approx. milk (guide):\n• 0–1m: 60–90ml/feed every 2–3h\n• 1–3m: 90–120ml/feed every 3–4h\n• 4–6m: 120–180ml/feed\n• After solids (6–12m): ~500–700ml/day (overall).`,
      meals: `Simple meal ideas (6–12m):\n• Porridge with salmon & spinach\n• Mashed sweet potato & tofu\n• Banana oat pancakes (no sugar)`,
      // allergy → AI better for personalization
    },
    aiPrompt: `Give age-appropriate feeding steps; emphasise choking/allergy safety and local SG guidance.`,
  },

  caregiver: {
    label: "Caregiving",
    chips: [
      { tag: "infantcare", label: "👶 Infantcare" },
      { tag: "mdw", label: "🧹 Helper / MDW" },
      { tag: "nanny", label: "👩 Nanny/Babysitter" },
    ],
    patterns: {
      infantcare: /infantcare|preschool|centre|center/i,
      mdw: /helper|mdw|maid|work\s?permit/i,
      nanny: /nanny|babysitter/i,
    },
    fixed: {
      infantcare: `Find infantcare (SG):\n1) Search by location & hours.\n2) Visit 2–3 centres; observe hygiene & ratios.\n3) Join waitlist; check subsidies.`,
      mdw: `Hire a helper (MDW):\n1) Check MOM eligibility; agency vs direct.\n2) Interview; define duties; buy insurance.\n3) IPA → arrival → work permit & orientation.`,
      nanny: `Nanny/babysitter:\n• Ask for infant CPR/first-aid, references, trial session.\n• Agree on hours, fees, sick-backup plan.\n• Consider infantcare for a structured setting if feasible.`,
    },
    aiPrompt: `If area-specific or comparison questions arise, summarise options & next steps; include ECDA/LifeSG/MOM references.`,
  },

  advice: {
    label: "Conflicting Advice",
    chips: [
      { tag: "evidence", label: "📚 Evidence first" },
      { tag: "plan", label: "🧭 Pick one plan" },
      { tag: "family", label: "👨‍👩‍👧 Talk to family" },
    ],
    patterns: {
      evidence: /evidence|research|guidelines|healthhub/i,
      plan: /pick one|choose|trial/i,
      family: /grand(ma|pa)|in-laws?|family/i,
    },
    aiPrompt: `Resolve conflicting advice: cite HealthHub guidance, choose one approach, trial 3–5 days, review respectfully with family.`,
  },
};

// ───────────────────── Keyboards (Main / Context / Footer) ───────────────────
const kbMain = {
  inline_keyboard: Object.entries(INTENTS).map(([flow, cfg]) => [
    {
      text:
        (flow === "cry"
          ? "🍼 "
          : flow === "nutrition"
          ? "🥣 "
          : flow === "caregiver"
          ? "👩‍🍼 "
          : "🧭 ") + cfg.label,
      callback_data: `flow:${flow}`,
    },
  ]),
};
const kbContext = (flow) => ({
  inline_keyboard: [
    ...INTENTS[flow].chips.map((c) => [
      { text: c.label, callback_data: `chip:${flow}:${c.tag}` },
    ]),
    [
      { text: "🔄 Change topic", callback_data: "nav:change" },
      { text: "🏠 Main menu", callback_data: "nav:home" },
    ],
  ],
});
const kbFooter = {
  inline_keyboard: [
    [
      { text: "🔄 Change topic", callback_data: "nav:change" },
      { text: "🏠 Main menu", callback_data: "nav:home" },
    ],
  ],
};

// ───────────────────── Helpers: HTTP & Telegram ─────────────────────
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

// ───────────────────── URL extraction & SG filter ───────────────────
function extractUrls(text = "") {
  const urls = Array.from(new Set(text.match(/https?:\/\/[^\s)\]]+/g) || []));
  return urls;
}
function isAllowedSG(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return SG_ALLOWED_HOSTS.some((dom) => h === dom || h.endsWith(`.${dom}`));
  } catch {
    return false;
  }
}
function mergeSgLinks(defaultLinks = [], aiLinks = []) {
  const filtered = [...defaultLinks, ...aiLinks.filter(isAllowedSG)];
  const unique = Array.from(new Set(filtered));
  return unique.slice(0, 6); // keep it tight
}

// ───────────────────── OpenAI helpers & judge ───────────────────────
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

// 1) Generate AI reply (no links appended here)
async function composeAI(flow, userText, chipTag = null, baseHint = "") {
  const system = `You are BabyGPT (Singapore). Short step-by-step guidance first, then one friendly line. ≤180 words.
No diagnosis. Emergencies → call 995. Prefer SG official links. Audience: first-time parents of newborns/toddlers.`;
  const rules = `House rules:
- Be concise and practical (steps 1-3).
- Use Singapore context (HealthHub, ECDA, MOM).
- Avoid medical claims; recommend GP/995 if urgent.
- Warm tone, not prescriptive.`;

  const chipHint = chipTag ? `Subtopic focus: ${chipTag}.` : "";
  const styleHint = INTENTS[flow]?.aiPrompt || "";

  const prompt = `User message:
"""${userText}"""

Context:
- Flow: ${flow}
- ${chipHint}
- ${styleHint}
- Base hint: ${baseHint}`;

  const text = await callOpenAI(async () => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "system", content: rules },
        { role: "user", content: prompt },
      ],
    });
    return (
      r.choices[0].message.content?.trim() || "Here are some steps you can try."
    );
  }, "composeAI");

  // return AI body + any SG links detected in it (filtered later)
  return { aiBody: text, aiLinksRaw: extractUrls(text) };
}

// 2) Judge: compare default vs AI and return which is better + confidence
async function judgeAnswers({ flow, userText, defaultText, aiText }) {
  const schema = {
    name: "AnswerJudge",
    schema: {
      type: "object",
      properties: {
        better: { type: "string", enum: ["default", "ai"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" },
      },
      required: ["better", "confidence", "reason"],
      additionalProperties: false,
    },
  };
  const judgePrompt = `Evaluate which answer better serves a new parent in Singapore.

Criteria (in order):
1) Accuracy and safety for newborn care (no diagnosis).
2) Local relevance (SG context, cite SG sources if any).
3) Clarity and actionability (step-first).
4) Brevity (≤180 words is good).

Return JSON only.

User:
"""${userText}"""
Flow: ${flow}

Default (canonical) answer:
"""${defaultText}"""

AI generated answer:
"""${aiText}"""`;

  const result = await callOpenAI(async () => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [
        {
          role: "system",
          content:
            "You are an impartial judge. Compare two answers and pick the better one with a confidence score 0–1.",
        },
        { role: "user", content: judgePrompt },
      ],
    });
    return JSON.parse(r.choices[0].message.content);
  }, "judgeAnswers");

  return result; // {better, confidence, reason}
}

// ───────────────────── Intent Matching Helpers ──────────────────────
function matchChipByRegex(flow, text) {
  const cfg = INTENTS[flow];
  if (!cfg?.patterns) return null;
  for (const [tag, re] of Object.entries(cfg.patterns)) {
    if (re.test(text)) return tag;
  }
  return null;
}
function ruleIntentTop(text) {
  const s = text.toLowerCase();
  if (/cry|sleep|colic|night waking|won'?t sleep/.test(s)) return "cry";
  if (/solid|wean|milk|feed|recipe|diet|meal/.test(s)) return "nutrition";
  if (
    /infantcare|preschool|nanny|babysitter|daycare|helper|mdw|maid|permit/.test(
      s
    )
  )
    return "caregiver";
  if (/conflicting|too many opinions|overload/.test(s)) return "advice";
  if (/overwhelmed|anxious|tired|burnt\s?out/.test(s)) return "wellbeing";
  if (/help|menu/.test(s)) return "help";
  return "unknown";
}

// ───────────────────── Telegram Webhook Handler ─────────────────────
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
    // Inline button taps
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data || "";
      log("🧲 callback_query:", { chatId, data });

      await answerCbq(cq.id);

      if (data.startsWith("flow:")) {
        const flow = data.split(":")[1];
        state.set(chatId, { flow, turns: 0 });
        const promptMap = {
          cry: "Tell me the crying/sleep details (age + when it happens).",
          nutrition:
            "What’s your feeding concern? (starting solids, milk amounts, meal ideas)",
          caregiver:
            "Which caregiver do you need? (infantcare, helper/MDW, nanny) & your area?",
          advice:
            "What conflicting advice are you getting? I’ll help you pick a plan.",
        };
        await sendMsg(
          chatId,
          `${promptMap[flow]}\n\n_Current topic: ${flow.toUpperCase()}._`,
          kbContext(flow),
          "send(context)"
        );
        return;
      }

      if (data.startsWith("chip:")) {
        const [, flow, tag] = data.split(":"); // e.g. chip:cry:night
        // Synthesize a short user text to route through the same logic
        const syn = `${flow} ${tag}`; // minimal hint
        await handleMessageLike(chatId, syn, {
          forcedFlow: flow,
          forcedTag: tag,
        });
        return;
      }

      if (data === "nav:home") {
        state.delete(chatId);
        await sendMsg(chatId, "Main menu:", kbMain, "send(home)");
        return;
      }
      if (data === "nav:change") {
        state.delete(chatId);
        await sendMsg(
          chatId,
          "Changing topic. What would you like help with now?",
          kbMain,
          "send(change)"
        );
        return;
      }
      return;
    }

    // Messages
    const m = upd.message || upd.edited_message;
    if (!m?.text) return;
    const chatId = m.chat.id;
    const text = m.text.trim();
    log(`📩 msg from ${chatId}:`, text);

    if (text === "/start") {
      state.delete(chatId);
      const intro = `
👶 *Hi, I'm BabyGPT (Singapore Edition)!*
Your friendly companion for first-time parents of babies aged 0–3.

I can help with:
1️⃣ *Health & Development* — sleep/crying, feeding & nutrition, milestones  
2️⃣ *Caregiving Support* — infantcare & helper info, and resolving conflicting advice  
3️⃣ *Parental Wellbeing* — gentle self-care pointers

I’m not a medical professional, but I’ll summarise steps and include trusted SG resources (HealthHub, ECDA, MOM).
*What would you like help with today?* 👇
      `;
      await sendMsg(chatId, intro.trim(), kbMain, "send(/start)");
      return;
    }

    if (EMERGENCY_RE.test(text)) {
      await sendMsg(
        chatId,
        "⚠️ This may be urgent. Please call 995 or go to the nearest A&E now.",
        kbMain
      );
      return;
    }
    if (OFFLIMIT_RE.test(text)) {
      await sendMsg(
        chatId,
        "Sorry, I can’t assist with that topic. If you feel unsafe, call SOS (1767) or IMH (6389 2222).",
        kbMain
      );
      return;
    }

    await handleMessageLike(chatId, text);
  } catch (err) {
    log("🔥 webhook handler error:", err);
  }
});

// ───────────────────── Core message routing (with judge) ─────────────────────
async function handleMessageLike(chatId, userText, options = {}) {
  const s = state.get(chatId) || {};
  let flow = options.forcedFlow || s.flow || ruleIntentTop(userText);
  if (flow === "help") {
    await sendMsg(chatId, "Choose a topic:", kbMain);
    return;
  }
  if (flow === "unknown") {
    // fallback to default flow (nutrition) to reduce friction
    flow = "nutrition";
  }

  // within a flow, detect chip tag
  let chipTag = options.forcedTag || matchChipByRegex(flow, userText);

  // Fixed default (if any)
  const defaultText =
    chipTag && INTENTS[flow]?.fixed?.[chipTag]
      ? INTENTS[flow].fixed[chipTag]
      : null;

  // Determine base hint for AI
  const baseHint =
    flow === "nutrition"
      ? "0–6m: milk on demand; 6–12m: start iron-rich solids; >12m: family meals; avoid choking."
      : flow === "cry"
      ? "Soothing: feed → burp → swaddle + white noise → dim lights; keep age-appropriate wake windows."
      : flow === "advice"
      ? "Resolver: 1) Prefer HealthHub guidance 2) Pick one approach 3) Trial 3–5 days, then review."
      : flow === "caregiver"
      ? "Summarise options; point to ECDA/LifeSG/MOM; give next-step checklist."
      : "";

  // Compose AI answer (and capture any links it mentions)
  let aiBody = null,
    aiLinksRaw = [];
  try {
    const out = await composeAI(flow, userText, chipTag, baseHint);
    aiBody = out.aiBody;
    aiLinksRaw = out.aiLinksRaw || [];
  } catch (err) {
    if (err.message === "openai_quota") {
      await sendMsg(
        chatId,
        "[debug] OpenAI API quota exceeded – please check API credits.",
        kbFooter
      );
      return;
    }
    throw err;
  }

  // Decide: default vs AI (judge), if defaultText exists
  let finalBody = aiBody;
  if (defaultText) {
    try {
      const verdict = await judgeAnswers({
        flow,
        userText,
        defaultText,
        aiText: aiBody,
      });
      log("🧪 judge verdict:", verdict);
      const useAI = verdict.better === "ai" && verdict.confidence >= 0.65;
      finalBody = useAI ? aiBody : defaultText;
    } catch (err) {
      if (err.message === "openai_quota") {
        // If judge failed due to quota, fall back to safe default
        finalBody = defaultText;
      } else {
        log("⚠️ judge error, using default:", err.message);
        finalBody = defaultText;
      }
    }
  }

  // Build “More information” links:
  //  - start with canonical flow links
  //  - add any SG-only links the AI provided
  const aiSgLinks = extractUrls(aiBody).filter(isAllowedSG);
  const mergedLinks = mergeSgLinks(SG_DEFAULT_LINKS[flow] || [], aiSgLinks);
  const moreInfo = mergedLinks.length
    ? "\n\n*More information:*\n" + mergedLinks.map((u) => `• ${u}`).join("\n")
    : "";

  // Always add disclaimer at the end
  const reply = `${finalBody}${moreInfo}\n\n_Disclaimer: General info only. For emergencies, call 995._`;

  // Track turns & footer
  const turns = (s.turns || 0) + 1;
  const replyKb =
    s.flow || options.forcedFlow ? (turns <= 3 ? kbFooter : undefined) : kbMain;
  state.set(chatId, { flow, turns });

  await sendMsg(chatId, reply, replyKb);
}

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
