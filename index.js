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

// per-chat state
const state = new Map(); // chatId -> { flow?: string, turns?: number }

// ───────────────────────────── Safety Rails ─────────────────────────
const EMERGENCY_RE =
  /(blue lips|not ?breathing|unresponsive|seizure|stiff neck|bulging fontanelle|fever\s?(?:40|4[01])|difficulty breathing)/i;
const OFFLIMIT_RE =
  /(self[- ]harm|suicide|sexual|violence|illegal|loan|money lending)/i;

// ───────────────────── SG “More information” links ──────────────────
const SG_DEFAULT_LINKS = {
  cry: [
    "https://www.healthhub.sg/programmes/parent-hub/baby-toddler/baby-sleep",
    "https://www.healthhub.sg/well-being-and-lifestyle/pregnancy-and-infant-health/help-my-baby-wont-stop-crying",
    "https://www.healthhub.sg/live-healthy/how-can-i-get-my-baby-to-sleep-well-and-safely",
    "https://www.healthhub.sg/live-healthy/surviving-sleep-deprivation-with-a-baby",
  ],
  nutrition: [
    "https://www.healthhub.sg/programmes/parent-hub/baby-toddler/childhood-healthy-diet",
    "https://www.healthhub.sg/programmes/parent-hub/recipes",
    "https://www.healthhub.sg/live-healthy/getting-baby-started-on-solids",
    "https://www.healthhub.sg/live-healthy/what-to-eat-while-breastfeeding",
    "https://www.healthhub.sg/live-healthy/child_choking",
  ],
  caregiver: [
    "https://www.ecda.gov.sg/parents/other-services/childminding-pilot-for-infants",
    "https://www.ecda.gov.sg/docs/default-source/default-document-library/parents/step-by-step-guide-for-parents.pdf",
    "https://www.ecda.gov.sg/beanstalk/parents-portal/parent-guides/choosing-a-preschool",
    "https://www.mom.gov.sg/passes-and-permits/work-permit-for-foreign-domestic-worker/publications-and-resources/hiring-an-mdw/8-steps-to-hiring-a-helper",
    "https://www.mom.gov.sg/passes-and-permits/work-permit-for-foreign-domestic-worker/publications-and-resources/hiring-an-mdw/are-you-eligible-to-hire-a-helper-in-singapore",
  ],
  advice: [
    "https://www.healthhub.sg/programmes/parent-hub/parentingforwellness",
    "https://www.ncss.gov.sg/research-and-insights/community-resources/mental-well-being/for-parents/",
    "https://zhenghua.pa.gov.sg/files/a%20parent_s%20guide%20to%20mental%20health%20in%20children%20and%20adolescents.pdf",
  ],
  wellbeing: [
    "https://www.healthhub.sg/live-healthy/the-abcs-of-healthy-screen-time-for-your-child",
  ],
  unknown: ["https://healthhub.sg"],
};
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
  "pa.gov.sg",
  "ncss.gov.sg",
  "lifesg.gov.sg",
  "data.gov.sg",
  "familiesforlife.sg",
];

// ───────────────── Intent Taxonomy (flows → chips) ──────────────────
const INTENTS = {
  cry: {
    label: "Crying / Sleep",
    chips: [
      { tag: "night", label: "🌙 Wakes at night" },
      { tag: "gas", label: "😣 Gas / tummy discomfort" },
      { tag: "naps", label: "💤 Day naps" },
      { tag: "bedtime", label: "🧸 Bedtime routine" },
    ],
    patterns: {
      night: /(night|3am|midnight|every\s?night|night\s?waking)/i,
      gas: /(gas|tummy|wind|strong crying|cry a lot|inconsolable)/i,
      naps: /\bnap(s)?\b|day\s?sleep/i,
      bedtime: /bedtime|wind.?down|routine/i,
    },
    fixed: {
      night: `Night waking basics:
1) Feed → burp 5–10 minutes.
2) Dark, quiet room + gentle white noise.
3) Keep age-appropriate awake windows. Too little/too much day sleep can affect nights.`,
      gas: `For gas / tummy discomfort and strong crying:
1) Hold baby upright or across your forearm (tummy facing down).
2) Gentle tummy massage + “bicycle” legs.
3) Short rocking or white noise can soothe. If there is vomiting, fever, or poor feeding → see a GP.`,
      naps: `Day naps:
1) Watch sleepy signs (yawns, glazed look).
2) Keep regular nap times and a short pre-nap routine.
3) Bright mornings, dim and quiet for naps.`,
      bedtime: `Bedtime routine (about 20–30 minutes):
• Bath → feed → short story or cuddle → lights out.
• Same order nightly; avoid screens 1 hour before bed.`,
    },
    aiPrompt: `Give simple step-by-step sleep/soothing guidance. No diagnosis. Mention age-appropriate awake windows.`,
  },
  nutrition: {
    label: "Nutrition",
    chips: [
      { tag: "solids", label: "🥄 Start solids" },
      { tag: "milk", label: "🍼 Milk amounts" },
      { tag: "meals", label: "🍚 Meal ideas" },
      { tag: "allergy", label: "🥜 Allergy / choking safety" },
    ],
    patterns: {
      solids: /start(ing)?\s?solids|wean/i,
      milk: /how much.*milk|ml|oz|formula|breast/i,
      meals: /meal|menu|recipe|ideas/i,
      allergy: /allerg(y|ies)|peanut|egg|choke|choking/i,
    },
    fixed: {
      solids: `Starting solids (6–12 months):
• Offer iron-rich foods daily; introduce one new food at a time.
• Sit upright; supervise closely; serve soft, safe textures.`,
      milk: `Approximate milk amounts (guide):
• 0–1m: 60–90ml per feed every 2–3h
• 1–3m: 90–120ml per feed every 3–4h
• 4–6m: 120–180ml per feed
• After solids (6–12m): about 500–700ml total per day`,
      meals: `Simple meal ideas (6–12 months):
• Porridge with salmon & spinach
• Mashed sweet potato & tofu
• Banana oat pancakes (no added sugar)`,
    },
    aiPrompt: `Give age-appropriate feeding steps; highlight choking/allergy safety with local SG context.`,
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
      infantcare: `Find infantcare in Singapore:
1) Search by your area and opening hours.
2) Visit 2–3 centres; observe hygiene and staff ratio.
3) Join waitlist; ask about fees and subsidies.`,
      mdw: `Hire a helper (MDW):
1) Check MOM rules; decide agency vs direct.
2) Interview; set duties; buy insurance.
3) IPA → arrival → work permit & orientation.`,
      nanny: `Nanny/Babysitter:
• Ask for infant CPR/first-aid, references, and a short trial.
• Agree on hours, duties, fees, and backup plan for sick days.
• Consider infantcare for a structured setting if possible.`,
    },
    aiPrompt: `For area-specific or comparison questions, summarise options and next steps; include ECDA/LifeSG/MOM references.`,
  },
  advice: {
    label: "Conflicting Advice",
    chips: [
      { tag: "evidence", label: "📚 Use trusted guidance" },
      { tag: "plan", label: "🧭 Choose one plan" },
      { tag: "family", label: "👨‍👩‍👧 Talk with family" },
    ],
    patterns: {
      evidence: /evidence|research|guidelines|healthhub/i,
      plan: /pick one|choose|trial/i,
      family: /grand(ma|pa)|in-laws?|family/i,
    },
    aiPrompt: `Help the parent choose a plan: refer to HealthHub guidance, choose one approach, try 3–5 days, then review with family.`,
  },
};

// ───────────────────── Contextual Tips (per flow) ───────────────────
const TIPS = {
  cry: [
    {
      tag: "safe-sleep",
      label: "🛏️ Safe sleep basics",
      text: `Safe sleep (0–12 months):
• Baby on back, firm flat surface, no pillows/blankets/soft toys.
• Room-share (not bed-share).
• Keep room cool and smoke-free.`,
    },
    {
      tag: "diaper-night",
      label: "🧷 Night diaper change",
      text: `Night diaper tips:
• Use an overnight diaper before last feed.
• Keep changes quick, warm, and mostly dark.
• Use barrier cream to prevent rash.`,
    },
    {
      tag: "soothing",
      label: "🫧 Soothing basics",
      text: `Soothing steps:
• Feed → burp 5–10 minutes.
• Swaddle (if age-appropriate), white noise, gentle rock.
• Dim lights; keep voices soft and calm.`,
    },
  ],
  nutrition: [
    {
      tag: "start-solids-check",
      label: "🥄 Ready for solids?",
      text: `Signs baby may be ready:
• Sits with support; good head control.
• Shows interest in food; opens mouth.
• Tongue thrust reduced. Start with soft, safe textures.`,
    },
    {
      tag: "choking-safety",
      label: "🚫 Choking safety",
      text: `Choking safety:
• No whole nuts, whole grapes, hard/raw chunks, popcorn.
• Cut foods into thin strips or pea-size pieces.
• Sit upright; supervise at all times.`,
    },
    {
      tag: "iron-foods",
      label: "🧲 Iron-rich foods",
      text: `Iron-rich ideas:
• Meat/chicken/fish (soft flakes)
• Egg (well-cooked), tofu, lentils
• Iron-fortified cereal`,
    },
  ],
  caregiver: [
    {
      tag: "visit-checklist",
      label: "📝 Centre visit checklist",
      text: `When visiting centres:
• Hygiene, staff ratio, safety gates.
• Caregiver warmth and how they talk to babies.
• Daily routine, nap space, feeding policy.`,
    },
    {
      tag: "mdw-interview",
      label: "🗣️ Helper interview tips",
      text: `Interview tips:
• Infant experience, night feeds.
• Agree on duties, rest days, phone use.
• Ask for references; check training/health.`,
    },
    {
      tag: "nanny-questions",
      label: "❓ Ask a nanny",
      text: `Questions:
• First-aid/CPR? References? Trial day?
• How do you handle feeding and naps?
• Backup plan if sick or late?`,
    },
  ],
  advice: [
    {
      tag: "family-talk",
      label: "👨‍👩‍👧 Family chat tips",
      text: `Talking with family:
• Start with thanks; share your plan briefly.
• Refer to HealthHub guidance to align facts.
• Suggest a 3–5 day trial; review together.`,
    },
    {
      tag: "one-plan",
      label: "🧭 Stick to one plan",
      text: `Avoid switching daily:
• Choose one approach that fits your family.
• Try for 3–5 days; track simple notes.
• Adjust calmly based on results.`,
    },
  ],
};

// ───────────────────── Keyboards (Main / Context / Tips / Footer) ────────────
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
    [{ text: "💡 Tips", callback_data: `tips:${flow}` }],
    [{ text: "💬 Type my own question", callback_data: `nav:type` }],
    [
      { text: "🔄 Change topic", callback_data: "nav:change" },
      { text: "🏠 Main menu", callback_data: "nav:home" },
    ],
  ],
});
const kbTipsMenu = (flow) => ({
  inline_keyboard: [
    ...(TIPS[flow] || []).map((t) => [
      { text: t.label, callback_data: `tip:${flow}:${t.tag}` },
    ]),
    [{ text: "⬅️ Back", callback_data: `flow:${flow}` }],
    [{ text: "🏠 Main menu", callback_data: "nav:home" }],
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

// ───────────────────── Retry Wrapper for Telegram ───────────────────
// 50 attempts, exponential backoff with cap; honor Retry-After where provided.
async function sendWithRetry(url, opts = {}, label = "fetch", maxRetries = 50) {
  let attempt = 0;
  const baseDelay = 250; // ms
  const maxDelay = 4000; // ms (≈ Telegram per-chat 1 msg/sec; cap at 4s)

  while (attempt <= maxRetries) {
    try {
      log(`→ [${label}] Attempt ${attempt + 1}: ${url}`);
      const res = await fetch(url, opts);
      const text = await res.text();
      if (res.ok) {
        log(`✅ [${label}] Success (${res.status})`);
        return JSON.parse(text);
      }

      if (res.status === 429 || res.status >= 500) {
        let delay = null;
        const retryAfterHeader = res.headers.get("Retry-After");
        if (retryAfterHeader) delay = parseInt(retryAfterHeader, 10) * 1000;
        else {
          try {
            const body = JSON.parse(text);
            const s = body?.parameters?.retry_after;
            if (typeof s === "number") delay = s * 1000;
          } catch {
            /* ignore */
          }
        }
        if (!delay) delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
        log(`⚠️ [${label}] HTTP ${res.status}, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }

      log(`❌ [${label}] Permanent failure: ${res.status} ${text}`);
      return null;
    } catch (err) {
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      log(
        `⚠️ [${label}] Network error (${
          err.code || err.message
        }), retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }

  log(`🚨 [${label}] All retries failed after ${maxRetries + 1} attempts.`);
  return null;
}
async function tgPost(method, payload, label = method) {
  return sendWithRetry(
    TG(method),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    label
  );
}
const sendMsg = (chat_id, text, keyboard, label = "sendMessage") =>
  tgPost(
    "sendMessage",
    {
      chat_id,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
      reply_markup: keyboard,
    },
    label
  );
const answerCbq = (id, label = "answerCallbackQuery") =>
  tgPost("answerCallbackQuery", { callback_query_id: id }, label);

// ───────────────────── URL extraction & SG filter ───────────────────
function extractUrls(text = "") {
  return Array.from(new Set(text.match(/https?:\/\/[^\s)\]]+/g) || []));
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
  return unique.slice(0, 6);
}

// ───────────────────── Link selection helpers (v1 grouping backported) ─────
function inferCaregiverSubtopic(text = "") {
  const s = text.toLowerCase();
  const p = INTENTS.caregiver?.patterns || {};
  if (p.infantcare && p.infantcare.test(s)) return "infantcare";
  if (p.mdw && p.mdw.test(s)) return "mdw";
  if (p.nanny && p.nanny.test(s)) return "nanny";
  // Heuristic: common preschool/infantcare words
  if (
    /\b(preschool|infant\s?care|infantcare|child\s?care|kindergarten|playgroup)\b/i.test(
      s
    )
  )
    return "infantcare";
  return null;
}

function defaultLinksFor(flow, userText, chipTag = null) {
  if (flow !== "caregiver") return SG_DEFAULT_LINKS[flow] || [];
  const sub = chipTag || inferCaregiverSubtopic(userText) || "generic";
  if (sub === "mdw") {
    return [
      "https://www.mom.gov.sg/passes-and-permits/work-permit-for-migrant-domestic-worker",
    ];
  }
  if (sub === "nanny") {
    return ["https://familiesforlife.sg/parenting"];
  }
  // infantcare/preschool or generic caregiver defaults
  return [
    "https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx",
    "https://www.ecda.gov.sg/docs/default-source/default-document-library/parents/step-by-step-guide-for-parents.pdf",
    "https://www.life.gov.sg/services/parenting/preschool",
  ];
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
  const system = `You are a friendly parenting helper. Keep it light, conversational, and generally helpful. Share a few ideas that might help. Keep it concise.`;
  const rules = `Guidelines:
- Be friendly and encouraging.
- Share general suggestions or tips.
- Keep it reasonably short when possible.`;

  const prompt = `User message:
"""${userText}"""

Context:
- Topic: ${flow}`;

  const text = await callOpenAI(async () => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        { role: "system", content: system },
        { role: "system", content: rules },
        { role: "user", content: prompt },
      ],
    });
    return (
      r.choices[0].message.content?.trim() || "Here are some ideas you can try."
    );
  }, "composeAI");

  return { aiBody: text, aiLinksRaw: extractUrls(text) };
}

// (Judge removed in this branch to demonstrate weaker rules)

// ───────────────────── Intent Matching Helpers ──────────────────────
function ruleIntentTop(text) {
  const s = text.toLowerCase();
  if (/cry|sleep|night waking|won'?t sleep|tummy|gas|strong crying/.test(s))
    return "cry";
  if (/solid|wean|milk|feed|recipe|diet|meal/.test(s)) return "nutrition";
  if (
    /infantcare|preschool|nanny|babysitter|daycare|helper|mdw|maid|permit/.test(
      s
    )
  )
    return "caregiver";
  if (/conflicting|too many opinions|overload|disagree/.test(s))
    return "advice";
  if (/overwhelmed|anxious|tired|burnt\s?out/.test(s)) return "wellbeing";
  if (/help|menu/.test(s)) return "help";
  return "unknown"; // let unknown flow go to AI with gentle persona
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
          cry: "Tell me your baby’s age and when the crying/sleep issue happens. 💬 *You can also type your own question anytime!*",
          nutrition:
            "Share your feeding concern (starting solids, milk amounts, meal ideas). 💬 *You can also type your own question anytime!*",
          caregiver:
            "Tell me what you need (infantcare, helper/MDW, nanny) and your area. 💬 *You can also type your own question anytime!*",
          advice:
            "Tell me the advice you’ve received and what feels confusing. 💬 *You can also type your own question anytime!*",
        };
        await sendMsg(
          chatId,
          `${promptMap[flow]}\n\n_Current topic: ${flow.toUpperCase()}._`,
          kbContext(flow),
          "send(context)"
        );
        return;
      }

      if (data.startsWith("tips:")) {
        const flow = data.split(":")[1];
        await sendMsg(
          chatId,
          "Here are some quick tips:",
          kbTipsMenu(flow),
          "send(tips-menu)"
        );
        return;
      }

      if (data.startsWith("tip:")) {
        const [, flow, tag] = data.split(":");
        const tip = (TIPS[flow] || []).find((t) => t.tag === tag);
        const body = tip ? tip.text : "No tip found.";
        await sendMsg(
          chatId,
          `${body}\n\n(You can still type your own question anytime.)`,
          kbFooter,
          "send(tip)"
        );
        return;
      }

      if (data.startsWith("chip:")) {
        // Chip taps: AI + judge vs canonical once.
        const [, flow, tag] = data.split(":");
        const syn = `${flow} ${tag}`;
        await handleMessageLike(chatId, syn, {
          forcedFlow: flow,
          forcedTag: tag,
        });
        return;
      }

      if (data === "nav:type") {
        await sendMsg(
          chatId,
          "Great—just type your question now. The buttons are optional.",
          kbFooter,
          "send(type-prompt)"
        );
        return;
      }
      if (data === "nav:home") {
        state.delete(chatId);
        await sendMsg(
          chatId,
          "Main menu (you can also type your own question anytime):",
          kbMain,
          "send(home)"
        );
        return;
      }
      if (data === "nav:change") {
        state.delete(chatId);
        await sendMsg(
          chatId,
          "Changing topic. Choose one below, or just type your question:",
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
Your friendly companion for *first-time parents* of babies aged *0–3 years*.

I can help with:
1️⃣ *Health & Development* — sleep & crying, feeding & growth milestones  
2️⃣ *Caregiving Support* — infantcare options, helpers, and resolving conflicting advice  
3️⃣ *Parental Wellbeing* — self-care and emotional balance

✨ *You don’t have to stick to buttons!*  
Just **type your question in your own words**, like:  
> “My baby keeps waking up at 3am, what should I do?”  
> “How much milk should a 4-month-old drink?”

I’m not a medical professional, but I’ll share practical steps and *trusted Singapore resources* (HealthHub, ECDA, MOM).

💬 *What would you like help with today?*`;
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

// ───────────────────── Core message routing (AI-first + unknown safe) ─────────────────────
async function handleMessageLike(chatId, userText, options = {}) {
  const s = state.get(chatId) || {};
  let flow = options.forcedFlow || s.flow || ruleIntentTop(userText);
  if (flow === "help") {
    await sendMsg(
      chatId,
      "Choose a topic below, or type your question:",
      kbMain
    );
    return;
  }

  // Only use chipTag if explicitly set by chip tap (prevents repeated hardcoded answers)
  const chipTag = options.forcedTag || null;

  // If unknown, use gentle persona; also show basic handles (Change topic/Main menu)
  const baseHint =
    flow === "unknown"
      ? "Be gentle and respectful. Encourage kindly. Avoid diagnosis. Offer practical next steps in simple words."
      : flow === "nutrition"
      ? "0–6m: milk on demand; 6–12m: start iron-rich solids; >12m: family meals; avoid choking."
      : flow === "cry"
      ? "Soothing: feed → burp → swaddle + white noise → dim lights; keep age-appropriate awake windows."
      : flow === "advice"
      ? "Plan: use trusted guidance (HealthHub), choose one approach, try 3–5 days, then review."
      : flow === "caregiver"
      ? "Summarise choices; link ECDA/LifeSG/MOM; give next-step checklist."
      : "";

  // Canonical defaults exist but we won't prefer them in this branch
  const defaultText =
    chipTag && INTENTS[flow]?.fixed?.[chipTag]
      ? INTENTS[flow].fixed[chipTag]
      : null;

  let aiBody = null;
  try {
    const out = await composeAI(flow, userText, chipTag, baseHint);
    aiBody = out.aiBody;
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

  // Always use AI output (weaker policy for comparison)
  let finalBody = aiBody;

  // Links (grouped defaults for caregiver; merge with AI links; limit to ~6)
  const aiLinks = extractUrls(aiBody);
  const baseLinks = defaultLinksFor(flow, userText, chipTag);
  const mergedLinks = Array.from(
    new Set([...(baseLinks || []), ...(aiLinks || [])])
  ).slice(0, 6);
  const moreInfo = mergedLinks.length
    ? "\n\n*More information:*\n" + mergedLinks.map((u) => `• ${u}`).join("\n")
    : "";

  // Disclaimer always
  const reply = `${finalBody}${moreInfo}\n\n_Note: General information only. For urgent concerns, seek professional help in your area._`;

  // Track turns
  const turns = (s.turns || 0) + 1;
  // Button policy:
  // - if unknown: always show footer (change/main) to guide user toward main intents
  // - otherwise: original behavior
  const replyKb =
    flow === "unknown"
      ? kbFooter
      : s.flow || options.forcedFlow
      ? turns <= 3
        ? kbFooter
        : undefined
      : kbMain;
  state.set(chatId, { flow, turns });

  await sendMsg(chatId, reply, replyKb);
}

// ───────────────────────── Health & Webhook setup ───────────────────
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, async () => {
  log(`🚀 BabyGPT server on :${PORT}`);
  log(`🧩 Ruleset: LOOSE/GENERIC (comparison branch)`);
  if (PUBLIC_URL && TELEGRAM_BOT_TOKEN) {
    await tgPost(
      "setWebhook",
      {
        url: `${PUBLIC_URL}/telegram/webhook`,
        allowed_updates: ["message", "callback_query", "edited_message"],
      },
      "setWebhook"
    );
  } else {
    log("⚠️ PUBLIC_URL or TELEGRAM_BOT_TOKEN missing; webhook not configured.");
  }
});
