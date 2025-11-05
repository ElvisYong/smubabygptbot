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
    "https://www.healthhub.sg/live-healthy/1637/baby_sleep_basics",
    "https://www.kkh.com.sg/healtharticles/baby-sleep-basics",
  ],
  nutrition: [
    "https://www.healthhub.sg/programmes/parent-hub/baby-toddler/childhood-healthy-diet",
    "https://www.healthhub.sg/programmes/parent-hub/recipes",
  ],
  caregiver: [
    "https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx",
    "https://www.ecda.gov.sg/docs/default-source/default-document-library/parents/step-by-step-guide-for-parents.pdf",
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
  unknown: [
    "https://familiesforlife.sg/parenting",
    "https://www.healthhub.sg/live-healthy",
  ],
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
      tag: "ecda-guide",
      label: "📄 ECDA step-by-step",
      text: `ECDA’s guide to finding preschool:
• Use the LifeSG app → Family & Parenting → Preschool.
• Search by area; filter service type = Infant care.
• Check fees, vacancies, opening hours; shortlist 2–3 centres.
• Arrange visits before deciding.

Full guide (PDF): https://www.ecda.gov.sg/docs/default-source/default-document-library/parents/step-by-step-guide-for-parents.pdf`,
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

// ───────────────────── ECDA infantcare lookup (Data.gov.sg) ───────────────────
let CHILDCARE_RESOURCE_ID = null;

async function fetchJsonWithTimeout(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function findChildcareResourceId() {
  if (CHILDCARE_RESOURCE_ID) return CHILDCARE_RESOURCE_ID;
  const queries = [
    "ecda preschool",
    "child care centres",
    "childcare centres",
    "preschool centres",
  ];
  for (const q of queries) {
    const url = `https://data.gov.sg/api/3/action/package_search?q=${encodeURIComponent(
      q
    )}`;
    const data = await fetchJsonWithTimeout(url, 4000);
    const pkgs = data?.result?.results || [];
    for (const p of pkgs) {
      const r = (p.resources || []).find((x) => x.datastore_active);
      if (r?.id) {
        CHILDCARE_RESOURCE_ID = r.id;
        return CHILDCARE_RESOURCE_ID;
      }
    }
  }
  return null;
}

function pickField(rec, candidates) {
  for (const c of candidates) {
    if (rec[c] != null && String(rec[c]).trim()) return String(rec[c]).trim();
  }
  // heuristic fallback: first key containing any token
  const keys = Object.keys(rec);
  for (const k of keys) {
    if (candidates.some((t) => k.toLowerCase().includes(t))) {
      const v = rec[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return "";
}

function normalizeYes(value) {
  const s = String(value).toLowerCase();
  return s === "y" || s === "yes" || s === "true" || s === "1";
}

async function searchInfantcareInArea(area, limit = 5) {
  const rid = await findChildcareResourceId();
  if (!rid) return [];
  const url = `https://data.gov.sg/api/3/action/datastore_search?resource_id=${rid}&q=${encodeURIComponent(
    area
  )}&limit=50`;
  const data = await fetchJsonWithTimeout(url, 5000);
  const records = data?.result?.records || [];
  const items = [];
  for (const rec of records) {
    // Try to detect infant care availability if field exists; otherwise keep
    const origKeys = Object.keys(rec);
    let offersInfant = true;
    const infantOrigKey = origKeys.find((k) => {
      const lk = k.toLowerCase();
      return lk.includes("infant") && !lk.includes("vac");
    });
    if (infantOrigKey) offersInfant = normalizeYes(rec[infantOrigKey]);

    if (!offersInfant) continue;
    const name =
      pickField(rec, [
        "centre_name",
        "centre name",
        "name",
        "centre",
        "centreName",
      ]) || "Unnamed centre";
    const address =
      pickField(rec, ["address", "addr", "street", "blk", "road"]) ||
      "Address unavailable";
    items.push({ name, address });
  }
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
    if (unique.length >= limit) break;
  }
  return unique;
}

function extractCaregiverAreaQuery(text = "") {
  const re = /\b(?:infant\s?care|infantcare|child\s?care|preschool)s?[^\n]*?\b(?:in|at|around|near)\s+([A-Za-z][A-Za-z \-]{1,40})\b/i;
  const m = text.match(re);
  if (!m) return null;
  return m[1].replace(/[^\w\s\-]/g, "").trim();
}

function isPreschoolOrInfantcareQuery(text = "") {
  const s = text.toLowerCase();
  return /\b(preschool|infant\s?care|infantcare|child\s?care|kindergarten|playgroup)\b/.test(s);
}

function buildLifeSgSteps(area = null) {
  const where = area ? ` in ${area}` : "";
  const header = `Preschool information in Singapore is governed by ECDA.\nUse the LifeSG app to find infant care/preschools${where}:`;
  const steps = [
    "Install/open LifeSG.",
    "Tap Family & Parenting → Preschool.",
    `Search by area${area ? ` (e.g. ${area})` : " or use Near Me"}.`,
    "Filter: Service type = Infant care (and set fees, vacancies, opening hours).",
    "Open a centre page to view address, fees, vacancies; add to shortlist.",
    "Shortlist 2–3 centres and arrange visits before deciding.",
  ].join("\n");
  const links = "LifeSG: https://www.life.gov.sg\nECDA Preschool Search (web): https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx\nECDA Step-by-step Guide (PDF): https://www.ecda.gov.sg/docs/default-source/default-document-library/parents/step-by-step-guide-for-parents.pdf";
  return `${header}\n${steps}\n\n${links}`;
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
  let system = `You are BabyGPT (Singapore). Short, clear steps first, then one friendly line. ≤180 words.
No diagnosis. Emergencies → call 995. Prefer SG official links. Audience: first-time parents of newborns/toddlers.`;

  // Gentle, respectful fallback persona for unknown topics
  if (flow === "unknown") {
    system = `You are BabyGPT (Singapore), a warm, respectful parenting assistant.
Be kind, non-judgmental, and supportive. Avoid diagnosis or medical claims.
Offer gentle encouragement, practical next steps, or simple resources when appropriate. Keep it ≤180 words.`;
  }

  const rules = `House rules:
- Use simple, friendly language.
- Singapore context (HealthHub, ECDA, MOM) when giving resources.
- Encourage seeing a GP for health concerns; emergencies → 995.`;

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
2) Local relevance (SG context, use SG sources).
3) Clarity and actionability (simple steps first).
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
            "You are an impartial judge. Compare two answers, pick the better one and give a confidence 0–1.",
        },
        { role: "user", content: judgePrompt },
      ],
    });
    return JSON.parse(r.choices[0].message.content);
  }, "judgeAnswers");

  return result; // {better, confidence, reason}
}

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
      ? "Explain that preschool information is governed by ECDA. For infant care search, guide users to the LifeSG app and provide concise steps: open LifeSG → Family & Parenting → Preschool → search by area → filter Service type=Infant care (and fees/vacancies) → shortlist and visit 2–3 centres. Include ECDA/LifeSG references."
      : "";

  // Canonical default only for one-time chip taps
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

  // Judge default vs AI (only on chip-tap first hop)
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
      if (err.message === "openai_quota") finalBody = defaultText;
      else {
        log("⚠️ judge error, using default:", err.message);
        finalBody = defaultText;
      }
    }
  }

  // Links
  // Local infantcare listing (caregiver flow + area)
  let localList = "";
  let lifesgGuide = "";
  if (flow === "caregiver") {
    const area = extractCaregiverAreaQuery(userText);
    if (area) {
      try {
        const centres = await searchInfantcareInArea(area, 5);
        if (centres.length) {
          const list = centres
            .map((c) => `• ${c.name} — ${c.address}`)
            .join("\n");
          localList = `Nearby infantcare in ${area}:\n${list}\n\nECDA Preschool Search: https://www.ecda.gov.sg/parents/Pages/Preschool-Search.aspx`;
        }
      } catch {}
    }
    if (isPreschoolOrInfantcareQuery(userText)) {
      lifesgGuide = buildLifeSgSteps(area);
    }
  }

  // Links
  const aiSgLinks = extractUrls(aiBody).filter(isAllowedSG);
  const mergedLinks = mergeSgLinks(SG_DEFAULT_LINKS[flow] || [], aiSgLinks);
  const moreInfo = mergedLinks.length
    ? "\n\n*More information:*\n" + mergedLinks.map((u) => `• ${u}`).join("\n")
    : "";

  // Disclaimer always
  const reply = `${lifesgGuide ? lifesgGuide + "\n\n" : ""}${localList ? localList + "\n\n" : ""}${finalBody}${moreInfo}\n\n_Reminder: General info only—every family is different. Trust yourself and learn as you go. For emergencies, call 995._`;

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
