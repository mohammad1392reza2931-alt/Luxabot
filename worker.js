// ربات ویرایش عکس روبیکا - Cloudflare Worker (نسخه‌ی حرفه‌ای)
// قابلیت‌ها: ۱) ادیتور حرفه‌ای شبیه لایت‌روم + پریست ساخته‌شده توسط هوش مصنوعی
//            ۲) چت با هوش مصنوعی درباره‌ی عکس (داخل ادیتور و داخل ربات)
//            ۳) پریست سریع  ۴) حذف بک‌گراند
// تنها چیزی که باید توی Secrets بذاری: RUBIKA_TOKEN

const API = "https://botapi.rubika.ir/v3/";

const AI_MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", tokensKey: "max_tokens", tokens: 400 },
  { id: "@cf/google/gemma-4-26b-a4b-it", tokensKey: "max_completion_tokens", tokens: 1200 },
];

const DEFAULT_PRESET = { brightness: 1.05, contrast: 1.1, saturation: 1.1, gamma: 1.0, sharpen: 1 };

const PROMPT =
  "You are a professional photo retoucher (Lightroom style). Look at this photo and decide global adjustments that make it look better. " +
  "Reply with ONLY a JSON object, no other text, with these keys: " +
  "brightness (0.8 to 1.35, 1 = no change), contrast (0.85 to 1.3), saturation (0.7 to 1.4), " +
  "gamma (0.7 to 1.4, above 1 brightens midtones), sharpen (0 to 3), " +
  "note (one short Persian sentence describing what you changed and why). " +
  "Rules: dark photo -> raise brightness/gamma; overexposed -> lower them; flat or hazy -> raise contrast; " +
  "dull colors -> raise saturation; oversaturated -> lower it; soft or blurry -> raise sharpen. " +
  "If the photo is already good keep values near 1. Be subtle and avoid extreme values.";

// ---------- پریست حرفه‌ای (ساختار شبیه لایت‌روم) ----------
const BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
const BAND_FA = { red: "قرمز", orange: "نارنجی", yellow: "زرد", green: "سبز", aqua: "فیروزه‌ای", blue: "آبی", purple: "بنفش", magenta: "سرخابی" };
const RANGES = {
  exposure: [-2, 2], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
  whites: [-100, 100], blacks: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100], clarity: [-100, 100], dehaze: [-100, 100],
  sharpen: [0, 100], vignette: [-100, 100], grain: [0, 100], fade: [0, 100],
};
const LABELS = {
  exposure: "نوردهی", contrast: "کنتراست", highlights: "هایلایت", shadows: "سایه‌ها", whites: "سفیدها", blacks: "سیاه‌ها",
  temperature: "دمای رنگ", tint: "تینت", vibrance: "ویبرنس", saturation: "اشباع", clarity: "کلاریتی",
  dehaze: "رفع مه", sharpen: "شارپ", vignette: "وینیت", grain: "گرین", fade: "فید",
};

const PRO_PROMPT =
  "You are a senior professional photo retoucher using Adobe Lightroom. Study this photo carefully (exposure, white balance, contrast, color cast, skin tones, sky, foliage, mood, noise) and build a complete professional edit preset. " +
  "Reply with ONLY one JSON object, no markdown, no extra text. Keys: " +
  "exposure (-2 to 2 EV), contrast, highlights, shadows, whites, blacks, temperature (positive = warmer), tint (positive = magenta), vibrance, saturation, clarity, dehaze (all -100 to 100), " +
  "sharpen (0 to 100), vignette (-100 to 100, negative darkens the corners), grain (0 to 100), fade (0 to 100), " +
  "hsl: an object with keys red, orange, yellow, green, aqua, blue, purple, magenta, each an array [hue, saturation, luminance] with values -100 to 100, " +
  "grade: an object {sh:[hue 0-360, strength 0-100], hi:[hue 0-360, strength 0-100]} for shadow and highlight color toning, " +
  "mono (0 or 1; use 1 only if a black-and-white look clearly suits the photo), " +
  "note (one short Persian sentence: which style you chose and why), " +
  "desc (two short Persian sentences describing the photo: subject, light, mood, problems). " +
  "Guidelines: fix problems first (too dark or bright, color cast, flat, hazy), then add a tasteful style. Protect skin tones (orange). " +
  "Typical values stay within +-30; use bigger values only when really needed. Set unused values to 0. Be subtle, natural and consistent.";

const EDIT_CHAT_PROMPT =
  "You are the AI assistant inside a Lightroom-style photo editor. Talk in short, friendly, colloquial Persian. The user chats about their photo and may ask for edits. " +
  "Reply with ONLY a JSON object: {\"reply\": \"short Persian answer\", \"set\": {...}}. " +
  "Include \"set\" ONLY when the user wants the edit changed. It contains only the keys you change, with absolute values (not deltas), same schema as the current preset: " +
  "exposure (-2..2), contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, dehaze (-100..100), sharpen, grain, fade (0..100), vignette (-100..100), mono (0 or 1), " +
  "hsl {red|orange|yellow|green|aqua|blue|purple|magenta: [hue, sat, lum] each -100..100}, grade {sh:[hue 0-360, strength 0-100], hi:[hue 0-360, strength 0-100]}. " +
  "Make moderate changes relative to the current preset. If the user only asks a question, omit \"set\" and answer using the photo description and the current preset.";

const WELCOME =
  "سلام 👋 من دستیار هوشمندتم!\n\n💬 هر سؤالی داری بنویس، باهات حرف می‌زنم\n🎛 عکس بفرست تا هوش مصنوعی تحلیلش کنه و یه پریست حرفه‌ای (شبیه لایت‌روم) بسازه؛ بعدش می‌تونی توی ادیتور همه‌چیزش رو تنظیم کنی و درباره‌ی عکس باهام حرف بزنی\n✨ ادیت سریع و ✂️ حذف بک‌گراند هم هست\n\n🗑 برای پاک کردن حافظه‌ی گفتگو: /new";

let TOKEN = "";
let ORIGIN = "";
const RECENT = new Map(); // جلوگیری از پردازش دوباره‌ی یک پیام

// ---------- روبیکا ----------
async function rub(method, body) {
  const r = await fetch(API + TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Rubika " + method + " " + r.status + " " + t.slice(0, 120));
  return JSON.parse(t);
}

async function send(chat, text, keypad) {
  const b = { chat_id: chat, text };
  if (keypad) b.inline_keypad = keypad;
  return rub("sendMessage", b);
}

async function upload(type, blob, name) {
  const d = await rub("requestSendFile", { type });
  const fd = new FormData();
  fd.append("file", blob, name);
  const r = await fetch(d.data.upload_url, { method: "POST", body: fd });
  const j = await r.json();
  if (!j.data || !j.data.file_id) throw new Error("آپلود فایل ناموفق بود");
  return j.data.file_id;
}

const KEYPAD = {
  rows: [
    { buttons: [{ id: "pro", type: "Simple", button_text: "🎛 ویرایش حرفه‌ای (ادیتور + هوش مصنوعی)" }] },
    { buttons: [{ id: "enhance", type: "Simple", button_text: "✨ بهبود سریع" }] },
    { buttons: [{ id: "bg", type: "Simple", button_text: "✂️ حذف بک‌گراند" }] },
    { buttons: [{ id: "both", type: "Simple", button_text: "✨✂️ هر دو" }] },
  ],
};

// ---------- ابزارهای کمکی ----------
async function hookKey(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + token));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function rid() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function num(v, lo, hi, def) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, v));
}

function pct(v) {
  const p = Math.round((v - 1) * 100);
  return (p > 0 ? "+" : "") + p + "%";
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

const json = (o, status) =>
  new Response(JSON.stringify(o), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

function isImage(file) {
  const name = String(file.file_name || "").toLowerCase();
  const m = name.match(/\.([a-z0-9]+)$/);
  if (!m) return true;
  return ["jpg", "jpeg", "png", "webp"].includes(m[1]);
}

function extractJSON(out) {
  let o = out;
  if (typeof o === "string") {
    const m = o.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { o = JSON.parse(m[0]); } catch (e) { return null; }
  }
  return o && typeof o === "object" ? o : null;
}

function pickText(r) {
  if (!r) return "";
  if (r.response !== undefined && r.response !== null) return typeof r.response === "string" ? r.response : JSON.stringify(r.response);
  if (r.choices && r.choices[0] && r.choices[0].message) return r.choices[0].message.content || "";
  return typeof r === "string" ? r : "";
}

async function downloadPhoto(fileId) {
  const info = await rub("getFile", { file_id: fileId });
  const url = info.data && info.data.download_url;
  if (!url) throw new Error("لینک دانلود عکس پیدا نشد");
  const dl = await fetch(url);
  if (!dl.ok) throw new Error("دانلود عکس ناموفق بود (" + dl.status + ")");
  return dl.arrayBuffer();
}

async function thumbB64(env, buf) {
  const res = (await env.IMAGES.input(new Blob([buf]).stream())
    .transform({ width: 640, height: 640, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 70 })).response();
  return toB64(new Uint8Array(await res.arrayBuffer()));
}

async function askModel(env, mdl, b64, prompt, tokens) {
  const body = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
      ],
    }],
  };
  body[mdl.tokensKey] = tokens || mdl.tokens;
  return pickText(await env.AI.run(mdl.id, body));
}

// ---------- پریست سریع (قدیمی) ----------
function parsePreset(out) {
  const o = extractJSON(out);
  if (!o) return null;
  if (!["brightness", "contrast", "saturation", "gamma", "sharpen"].some((k) => k in o)) return null;
  return {
    brightness: num(o.brightness, 0.8, 1.35, 1),
    contrast: num(o.contrast, 0.85, 1.3, 1),
    saturation: num(o.saturation, 0.7, 1.4, 1),
    gamma: num(o.gamma, 0.7, 1.4, 1),
    sharpen: num(o.sharpen, 0, 3, 0),
    note: typeof o.note === "string" ? o.note.slice(0, 200) : "",
  };
}

async function makePreset(env, buf) {
  try {
    const b64 = await thumbB64(env, buf);
    for (const mdl of AI_MODELS) {
      try {
        const p = parsePreset(await askModel(env, mdl, b64, PROMPT));
        if (p) return p;
      } catch (e) { console.log("AI " + mdl.id + ": " + e.message); }
    }
  } catch (e) { console.log("preset error: " + e.message); }
  return { ...DEFAULT_PRESET, note: "هوش مصنوعی جواب نداد؛ یه پریست ملایم عمومی اعمال شد." };
}

// ---------- پریست حرفه‌ای ----------
function blankPreset() {
  const hsl = {};
  for (const b of BANDS) hsl[b] = [0, 0, 0];
  const p = { mono: 0, hsl, grade: { sh: [0, 0], hi: [0, 0] } };
  for (const k in RANGES) p[k] = 0;
  return p;
}

// ادغام (و محدود کردن) یک پریست ناقص روی پریست پایه
function cleanPreset(o, base) {
  const p = JSON.parse(JSON.stringify(base || blankPreset()));
  if (!o || typeof o !== "object") return p;
  for (const k in RANGES) if (k in o) p[k] = num(o[k], RANGES[k][0], RANGES[k][1], p[k]);
  if (o.hsl && typeof o.hsl === "object") {
    for (const b of BANDS) {
      const a = o.hsl[b];
      if (Array.isArray(a)) p.hsl[b] = [0, 1, 2].map((i) => num(a[i], -100, 100, p.hsl[b][i]));
    }
  }
  if (o.grade && typeof o.grade === "object") {
    for (const z of ["sh", "hi"]) {
      const a = o.grade[z];
      if (Array.isArray(a)) p.grade[z] = [num(a[0], 0, 360, p.grade[z][0]), num(a[1], 0, 100, p.grade[z][1])];
    }
  }
  if ("mono" in o) p.mono = o.mono ? 1 : 0;
  return p;
}

function summary(p) {
  const a = [];
  for (const k in LABELS) {
    const v = p[k];
    if (v) a.push(LABELS[k] + " " + (v > 0 ? "+" : "") + Math.round(v * 10) / 10);
  }
  const hs = BANDS.filter((b) => p.hsl[b].some((x) => x)).map((b) => BAND_FA[b]);
  if (hs.length) a.push("HSL (" + hs.join("، ") + ")");
  if (p.grade.sh[1] || p.grade.hi[1]) a.push("رنگ‌بندی سایه/هایلایت");
  if (p.mono) a.push("سیاه‌وسفید");
  return a.join(" • ");
}

async function makeProPreset(env, buf) {
  try {
    const b64 = await thumbB64(env, buf);
    for (const mdl of AI_MODELS) {
      try {
        const o = extractJSON(await askModel(env, mdl, b64, PRO_PROMPT, mdl.tokensKey === "max_tokens" ? 1000 : 2200));
        if (o && Object.keys(o).length > 3) return { preset: cleanPreset(o), note: str(o.note, 200), desc: str(o.desc, 400) };
      } catch (e) { console.log("PRO " + mdl.id + ": " + e.message); }
    }
  } catch (e) { console.log("pro preset error: " + e.message); }
  return {
    preset: cleanPreset({ contrast: 8, shadows: 8, vibrance: 15, clarity: 10, sharpen: 25 }),
    note: "هوش مصنوعی جواب نداد؛ یه پریست ملایم عمومی ساخته شد.",
    desc: "",
  };
}

// ---------- پردازش اصلی ----------
async function runPro(env, chat) {
  const raw = await env.STATE.get("u:" + chat);
  if (!raw) return send(chat, "اول یه عکس بفرست 📷");
  const s = JSON.parse(raw);
  await send(chat, "🧠 هوش مصنوعی داره عکس رو تحلیل می‌کنه و پریست حرفه‌ای می‌سازه... چند ثانیه صبر کن");
  const buf = await downloadPhoto(s.id);
  const r = await makeProPreset(env, buf);
  const id = rid();
  await env.STATE.put("e:" + id, JSON.stringify({ chat, fid: s.id, preset: r.preset, note: r.note, desc: r.desc }), { expirationTtl: 21600 });
  await env.STATE.put("d:" + chat, JSON.stringify({ desc: r.desc, preset: r.preset, id }), { expirationTtl: 86400 });
  const link = ORIGIN + "/e/" + id;
  const text =
    "🎛 پریست حرفه‌ای ساخته شد!\n\n" +
    (r.note ? r.note + "\n\n" : "") +
    (r.desc ? "📷 " + r.desc + "\n\n" : "") +
    "تنظیمات: " + (summary(r.preset) || "—") +
    "\n\n👇 ادیتور رو باز کن؛ پریست روی عکس اعمال شده و همه‌ی اسلایدرها (نور، رنگ، HSL، وضوح، افکت) دستته. همون‌جا می‌تونی با هوش مصنوعی درباره‌ی عکس هم حرف بزنی و نتیجه رو برای همین ربات بفرستی.\n\n" +
    link + "\n\n(لینک ۶ ساعت اعتبار داره)";
  const keypad = { rows: [{ buttons: [{ id: "open", type: "Link", button_text: "🎛 باز کردن ادیتور", button_link: { type: "url", link_url: link } }] }] };
  try { await send(chat, text, keypad); } catch (e) { await send(chat, text); }
}

async function runAction(env, chat, action) {
  if (action === "pro") return runPro(env, chat);
  const raw = await env.STATE.get("u:" + chat);
  if (!raw) return send(chat, "اول یه عکس بفرست 📷");
  const s = JSON.parse(raw);
  await send(chat, "⏳ در حال پردازش... چند ثانیه صبر کن");

  const buf = await downloadPhoto(s.id);

  let preset = null;
  if (action === "enhance" || action === "both") preset = await makePreset(env, buf);

  let img = env.IMAGES.input(new Blob([buf]).stream());
  if (preset) {
    img = img.transform({
      brightness: preset.brightness,
      contrast: preset.contrast,
      saturation: preset.saturation,
      gamma: preset.gamma,
      sharpen: preset.sharpen,
    });
  }
  const removeBg = action === "bg" || action === "both";
  if (removeBg) img = img.transform({ segment: "foreground" });

  const out = (await img.output(removeBg ? { format: "image/png" } : { format: "image/jpeg", quality: 92 })).response();
  const bytes = await out.arrayBuffer();

  let caption = "";
  if (preset) {
    caption =
      "✨ پریست هوشمند اعمال شد\n" + (preset.note ? preset.note + "\n" : "") +
      "\n🔆 روشنایی: " + pct(preset.brightness) +
      "\n◐ کنتراست: " + pct(preset.contrast) +
      "\n🎨 اشباع رنگ: " + pct(preset.saturation) +
      "\n🌗 گاما: " + pct(preset.gamma) +
      "\n🔍 وضوح: " + preset.sharpen.toFixed(1);
  }
  if (removeBg) caption += (caption ? "\n\n" : "") + "✂️ بک‌گراند حذف شد (فایل PNG با پس‌زمینه‌ی شفاف)";
  caption += "\n\nبرای ویرایش بعدی، عکس جدید بفرست 📷";

  // PNG به‌صورت فایل فرستاده می‌شه تا شفافیتش از بین نره
  const blob = new Blob([bytes], { type: removeBg ? "image/png" : "image/jpeg" });
  const fid = await upload(removeBg ? "File" : "Image", blob, removeBg ? "result.png" : "result.jpg");
  await rub("sendFile", { chat_id: chat, file_id: fid, text: caption });
}

// ---------- گفتگوی دستیار ----------
const SYSTEM_PROMPT =
  "تو یک دستیار روزمره‌ی صمیمی و کاربلد هستی که داخل روبیکا کار می‌کنی. به فارسی روان و محاوره‌ای جواب بده، " +
  "کوتاه و مفید باش (مگه اینکه کاربر توضیح کامل بخواد). اگه چیزی رو نمی‌دونی صادقانه بگو. " +
  "تو می‌تونی عکس‌ها رو ویرایش کنی (ادیتور حرفه‌ای شبیه لایت‌روم با پریست هوشمند، ادیت سریع و حذف بک‌گراند): اگه کاربر خواست، بهش بگو عکسش رو بفرسته. " +
  "حذف اشیای داخل عکس فعلاً ممکن نیست.";
const HISTORY_LIMIT = 8; // تعداد پیام‌هایی که یادش می‌مونه

async function chatReply(env, chat, userText) {
  let hist = [];
  try { hist = JSON.parse((await env.STATE.get("h:" + chat)) || "[]"); } catch (e) {}
  let sys = SYSTEM_PROMPT;
  try {
    const d = JSON.parse((await env.STATE.get("d:" + chat)) || "null");
    if (d && d.desc) {
      sys += "\n\nآخرین عکسی که کاربر فرستاده: " + d.desc + " | تنظیماتی که هوش مصنوعی برایش ساخته: " + summary(d.preset) +
        ". اگه کاربر درباره‌ی این عکس سؤال کرد با همین اطلاعات جواب بده. برای تغییر بیشتر بهش بگو از چت داخل ادیتور بخواد.";
    }
  } catch (e) {}
  const messages = [{ role: "system", content: sys }, ...hist, { role: "user", content: userText.slice(0, 2000) }];
  let answer = "";
  for (const mdl of AI_MODELS) {
    try {
      const body = { messages };
      body[mdl.tokensKey] = mdl.tokens + 400;
      const out = pickText(await env.AI.run(mdl.id, body));
      if (typeof out === "string" && out.trim()) { answer = out.trim(); break; }
    } catch (e) { console.log("chat " + mdl.id + ": " + e.message); }
  }
  if (!answer) throw new Error("هوش مصنوعی جواب نداد (شاید سهمیه‌ی رایگان امروز تموم شده)");
  hist.push({ role: "user", content: userText.slice(0, 600) }, { role: "assistant", content: answer.slice(0, 900) });
  await env.STATE.put("h:" + chat, JSON.stringify(hist.slice(-HISTORY_LIMIT)), { expirationTtl: 86400 });
  return answer.slice(0, 3800);
}

function textToAction(t) {
  if (/هر دو|both/.test(t)) return "both";
  if (/بک|پس.?زمینه|bg|background/.test(t)) return "bg";
  if (/حرفه|ادیتور|pro/.test(t)) return "pro";
  if (/بهبود|پریست|کیفیت|enhance|preset/.test(t)) return "enhance";
  return null;
}

async function handle(env, m) {
  const chat = m.chat;
  try {
    if (m.button) return await runAction(env, chat, m.button);
    if (m.file) {
      if (!isImage(m.file)) return await send(chat, "فعلاً فقط عکس (jpg / png / webp) قبول می‌کنم 🙂");
      await env.STATE.put(
        "u:" + chat,
        JSON.stringify({ id: m.file.file_id || m.file.id }),
        { expirationTtl: 3600 }
      );
      return await send(chat, "عکس دریافت شد ✅\nچه کاری روش انجام بدم؟", KEYPAD);
    }
    const t = (m.text || "").trim();
    if (!t || t === "/start" || t === "start") return await send(chat, WELCOME);
    if (t === "/new") {
      await env.STATE.delete("h:" + chat);
      return await send(chat, "حافظه‌ی گفتگو پاک شد ✅");
    }
    // دستور کوتاه متنی برای عکس (فقط اگه پیام خیلی کوتاه باشه)
    if (t.length <= 20) {
      const a = textToAction(t.toLowerCase());
      if (a && (await env.STATE.get("u:" + chat))) return await runAction(env, chat, a);
    }
    return await send(chat, await chatReply(env, chat, t));
  } catch (e) {
    console.log("handle error: " + e.message);
    try { await send(chat, "❌ خطا: " + e.message); } catch (x) {}
  }
}

// ---------- خوندن آپدیت‌های روبیکا ----------
const IGNORED = ["RemovedMessage", "UpdatedMessage", "UpdatedPayment", "StoppedBot"];

function normalize(b) {
  let chat, m, type = "NewMessage";
  if (b.inline_message) {
    m = b.inline_message;
    chat = m.chat_id;
  } else {
    const u = b.update || b;
    type = u.type;
    chat = u.chat_id;
    if (type === "StartedBot") return chat ? { chat, text: "/start" } : null;
    m = u.new_message || null;
    if (IGNORED.includes(type)) return { ignore: true };
  }
  if (!chat || !m) return null;
  if (m.sender_type === "Bot") return { ignore: true };
  const file = m.file || (Array.isArray(m.files) && m.files[0]) || null;
  return {
    chat,
    mid: String(m.message_id || ""),
    text: String(m.text || "").trim(),
    file: file && (file.file_id || file.id) ? file : null,
    button: m.aux_data && m.aux_data.button_id ? String(m.aux_data.button_id) : "",
  };
}

async function handleUpdate(env, body) {
  const items = Array.isArray(body.updates) ? body.updates : [body];
  for (const it of items) {
    const m = normalize(it);
    if (!m) {
      try { await env.STATE.put("dbg", JSON.stringify(it).slice(0, 1500)); } catch (e) {}
      continue;
    }
    if (m.ignore) continue;
    // جلوگیری از پردازش دوباره‌ی همون پیام (اگه روبیکا دوباره بفرسته)
    const k = m.chat + "|" + m.mid + "|" + m.button;
    const now = Date.now();
    if (RECENT.get(k) && now - RECENT.get(k) < 20000) continue;
    RECENT.set(k, now);
    if (RECENT.size > 200) RECENT.clear();
    await handle(env, m);
  }
}

// ---------- وب‌اپ ادیتور: API ----------
async function editorChat(env, s, b) {
  const cur = cleanPreset(b.current, s.preset);
  const hist = Array.isArray(b.history)
    ? b.history.slice(-6).map((h) => ({ role: h && h.role === "assistant" ? "assistant" : "user", content: String((h && h.content) || "").slice(0, 600) }))
    : [];
  const sys = EDIT_CHAT_PROMPT + "\n\nPhoto description: " + (s.desc || "(none)") + "\nCurrent preset JSON: " + JSON.stringify(cur);
  const messages = [{ role: "system", content: sys }, ...hist, { role: "user", content: String(b.message || "").slice(0, 800) }];
  let text = "";
  for (const mdl of AI_MODELS) {
    try {
      const body = { messages };
      body[mdl.tokensKey] = mdl.tokens + 800;
      const out = pickText(await env.AI.run(mdl.id, body));
      if (out && out.trim()) { text = out.trim(); break; }
    } catch (e) { console.log("editor chat " + mdl.id + ": " + e.message); }
  }
  if (!text) throw new Error("هوش مصنوعی جواب نداد (شاید سهمیه‌ی رایگان امروز تموم شده)");
  const o = extractJSON(text);
  if (o && (o.reply || o.set)) {
    const next = o.set ? cleanPreset(o.set, cur) : cur;
    return { reply: str(o.reply, 800) || "انجام شد ✅", preset: next, changed: !!o.set };
  }
  return { reply: text.slice(0, 800), preset: cur, changed: false };
}

async function web(request, env, u) {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "e") {
    return new Response(EDITOR_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const action = parts[1];
  const id = parts[2] || "";
  if (!/^[a-f0-9]{24}$/.test(id)) return json({ error: "لینک نامعتبره" }, 400);
  const raw = await env.STATE.get("e:" + id);
  if (!raw) return json({ error: "لینک منقضی شده؛ عکس رو دوباره برای ربات بفرست" }, 404);
  const s = JSON.parse(raw);
  const post = request.method === "POST";
  try {
    if (action === "state" && !post) return json({ preset: s.preset, note: s.note, desc: s.desc });
    if (action === "img" && !post) {
      const buf = await downloadPhoto(s.fid);
      const res = (await env.IMAGES.input(new Blob([buf]).stream())
        .transform({ width: 1920, height: 1920, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 92 })).response();
      return new Response(await res.arrayBuffer(), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
    }
    if (action === "chat" && post) {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      return json(await editorChat(env, s, b));
    }
    if (action === "send" && post) {
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 15000000) return json({ error: "حجم فایل نامعتبره" }, 400);
      const fid = await upload("Image", new Blob([bytes], { type: "image/jpeg" }), "edited.jpg");
      await rub("sendFile", { chat_id: s.chat, file_id: fid, text: "🎛 نتیجه‌ی ادیت حرفه‌ای ✅" });
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.log("web error: " + e.message);
    return json({ error: e.message }, 500);
  }
}

// ---------- ورودی Worker ----------
const txt = (s, status) => new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env, ctx) {
    TOKEN = env.RUBIKA_TOKEN || "";
    if (!TOKEN) return txt("RUBIKA_TOKEN توی Secrets تنظیم نشده.", 500);
    const u = new URL(request.url);
    ORIGIN = u.origin;

    // ادیتور وب و API اون
    if (u.pathname.startsWith("/e/") || u.pathname.startsWith("/api/")) return web(request, env, u);

    const key = await hookKey(TOKEN);

    // دریافت پیام‌ها از روبیکا
    if (request.method === "POST") {
      if (!u.pathname.startsWith("/hook/" + key)) return txt("no", 403);
      let body;
      try { body = await request.json(); } catch (e) { return txt("ok"); }
      ctx.waitUntil(handleUpdate(env, body).catch((e) => console.log("update error: " + e.message)));
      return txt("ok");
    }

    // یک بار این آدرس رو باز کن تا روبیکا به Worker وصل بشه
    if (u.pathname === "/setup") {
      const hook = u.origin + "/hook/" + key;
      const lines = [];
      for (const type of ["ReceiveUpdate", "ReceiveInlineMessage"]) {
        try {
          const r = await rub("updateBotEndpoints", { url: hook, type });
          lines.push(type + ": " + JSON.stringify(r));
        } catch (e) { lines.push(type + " ERROR: " + e.message); }
      }
      try {
        const me = await rub("getMe", {});
        lines.push("getMe: " + JSON.stringify(me));
      } catch (e) { lines.push("getMe ERROR: " + e.message); }
      return txt(lines.join("\n\n"));
    }

    // برای عیب‌یابی: /debug?t=۸ حرف آخر توکن
    if (u.pathname === "/debug") {
      if (u.searchParams.get("t") !== TOKEN.slice(-8)) return txt("no", 403);
      return txt((await env.STATE.get("dbg")) || "چیزی ثبت نشده.");
    }

    return txt("ربات روشنه ✅");
  },
};

// ======================================================================
// صفحه‌ی ادیتور (HTML + JS سمت مرورگر). پردازش پیکسلی کامل داخل مرورگر انجام می‌شه.
// نکته: داخل این بلوک بک‌تیک و ${ استفاده نشده تا template literal خراب نشه.
// ======================================================================
const EDITOR_HTML = String.raw`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ادیتور حرفه‌ای</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:#0e1014;color:#e8eaf0;font-family:system-ui,Tahoma,sans-serif;direction:rtl;padding-bottom:70px}
header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#151922;position:sticky;top:0;z-index:5;font-size:15px}
#status{font-size:12px;color:#8fa0b8}
#stage{position:relative;background:#000;padding:6px 0}
#cv{max-width:100%;max-height:40vh;display:block;margin:0 auto}
#hist{position:absolute;left:8px;bottom:8px;width:110px;height:36px;background:rgba(0,0,0,.5);border-radius:6px}
.chips{display:flex;gap:8px;overflow-x:auto;padding:8px 10px;scrollbar-width:none}
.chips button,.tabs button{flex:none;border:1px solid #2a3140;background:#1a1f2b;color:#dfe5f0;border-radius:18px;padding:7px 13px;font-size:13px}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:4px 10px;scrollbar-width:none;border-bottom:1px solid #1d2330}
.tabs button.on,.chips button.on,.tg.on{background:#2b6cff;border-color:#2b6cff;color:#fff}
.panel{display:none;padding:10px 14px}
.panel.on{display:block}
.row{margin:10px 0}
.row .top{display:flex;align-items:center;gap:8px;font-size:13px}
.row .top span{flex:1}
.row .top b{color:#7fb2ff;min-width:44px;text-align:left;direction:ltr}
.rs{border:0;background:none;color:#6b7690;font-size:16px;padding:0 4px}
input[type=range]{width:100%;direction:ltr;accent-color:#4f9dff;margin:6px 0 0}
.tg{border:1px solid #2a3140;background:#1a1f2b;color:#dfe5f0;border-radius:10px;padding:9px 14px;font-size:13px;margin:4px 4px 4px 0}
.note{background:#151b27;border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.8;margin-bottom:10px;white-space:pre-wrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-left:6px;vertical-align:middle}
#msgs{height:210px;overflow-y:auto;background:#0b0d11;border-radius:12px;padding:8px}
.b{padding:8px 11px;border-radius:12px;margin:6px 0;white-space:pre-wrap;max-width:90%;font-size:13px;line-height:1.7}
.b.u{background:#2b6cff;margin-right:0;margin-left:auto}
.b.a{background:#1d2431}
#cin{display:flex;gap:6px;margin-top:8px}
#cin input{flex:1;background:#1a1f2b;border:1px solid #2a3140;color:#fff;border-radius:12px;padding:10px;font-size:14px}
#cin button{background:#2b6cff;color:#fff;border:0;border-radius:12px;padding:0 16px}
footer{position:fixed;bottom:0;left:0;right:0;display:flex;gap:6px;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:#151922;z-index:6}
footer button{flex:1;border:0;border-radius:12px;padding:11px 4px;background:#222a3a;color:#fff;font-size:13px}
footer .main{background:#2b6cff;flex:1.6}
#toast{position:fixed;bottom:76px;left:50%;transform:translateX(-50%);background:#000c;color:#fff;padding:9px 16px;border-radius:20px;font-size:13px;display:none;z-index:9;max-width:90%;text-align:center}
</style></head>
<body>
<header><b>🎛 ادیتور حرفه‌ای</b><span id="status">در حال بارگذاری...</span></header>
<div id="stage"><canvas id="cv"></canvas><canvas id="hist" width="220" height="72"></canvas></div>
<div class="chips" id="looks"></div>
<div class="tabs" id="tabs"></div>
<div id="panels"></div>
<footer>
<button id="bCmp">👁 اصل</button>
<button id="bReset">↩️ ریست</button>
<button id="bDl">⬇️</button>
<button id="bSend" class="main">📤 ارسال به ربات</button>
</footer>
<div id="toast"></div>
<script>
(function(){
/*ENGINE_START*/
var BANDS=["red","orange","yellow","green","aqua","blue","purple","magenta"];
var CENT=[0,30,60,120,180,240,275,320];
function blank(){
  var p={exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0,temperature:0,tint:0,vibrance:0,saturation:0,clarity:0,dehaze:0,sharpen:0,vignette:0,grain:0,fade:0,mono:0,hsl:{},grade:{sh:[0,0],hi:[0,0]}};
  for(var i=0;i<8;i++)p.hsl[BANDS[i]]=[0,0,0];
  return p;
}
function applyPartial(P,o){
  for(var k in o){
    if(k==="hsl"){for(var b in o.hsl)if(P.hsl[b])P.hsl[b]=o.hsl[b].slice();}
    else if(k==="grade"){for(var z in o.grade)if(P.grade[z])P.grade[z]=o.grade[z].slice();}
    else P[k]=o[k];
  }
}
function h2(p,q,t){
  if(t<0)t+=1; if(t>1)t-=1;
  if(t<1/6)return p+(q-p)*6*t;
  if(t<0.5)return q;
  if(t<2/3)return p+(q-p)*(2/3-t)*6;
  return p;
}
function tintVec(deg){
  var r=h2(0,1,deg/360+1/3),g=h2(0,1,deg/360),b=h2(0,1,deg/360-1/3),y=0.299*r+0.587*g+0.114*b;
  return [r-y,g-y,b-y];
}
function boxBlur(src,w,h,r){
  var tmp=new Float32Array(src.length),out=new Float32Array(src.length),d=2*r+1,x,y,k,acc,a,b,o;
  for(y=0;y<h;y++){
    o=y*w;acc=0;
    for(k=-r;k<=r;k++)acc+=src[o+Math.min(w-1,Math.max(0,k))];
    for(x=0;x<w;x++){
      tmp[o+x]=acc/d;
      a=Math.min(w-1,x+r+1);b=Math.max(0,x-r);
      acc+=src[o+a]-src[o+b];
    }
  }
  for(x=0;x<w;x++){
    acc=0;
    for(k=-r;k<=r;k++)acc+=tmp[Math.min(h-1,Math.max(0,k))*w+x];
    for(y=0;y<h;y++){
      out[y*w+x]=acc/d;
      a=Math.min(h-1,y+r+1);b=Math.max(0,y-r);
      acc+=tmp[a*w+x]-tmp[b*w+x];
    }
  }
  return out;
}
function buildLUT(P){
  var lut=new Float32Array(256);
  var ev=Math.pow(2,P.exposure),sh=P.shadows/100,hi=P.highlights/100,wh=P.whites/100,bl=P.blacks/100,c=P.contrast/100,fd=P.fade/100;
  for(var i=0;i<256;i++){
    var x=i/255,inv;
    if(P.exposure!==0)x=Math.pow(Math.min(1,Math.pow(x,2.2)*ev),1/2.2);
    inv=1-x;
    x+=sh*0.25*6.75*x*inv*inv;
    x+=hi*0.25*6.75*inv*x*x;
    x=Math.min(1,Math.max(0,x));inv=1-x;
    x+=bl*0.15*inv*inv*inv;
    x+=wh*0.15*x*x*x;
    x=Math.min(1,Math.max(0,x));
    if(c>0){var s=x*x*(3-2*x);x=x+(s-x)*Math.min(1,c*1.25);}
    else if(c<0){x=0.5+(x-0.5)*(1+c*0.7);}
    if(fd>0)x=fd*0.12+x*(1-fd*0.12);
    lut[i]=Math.min(1,Math.max(0,x))*255;
  }
  return lut;
}
function passA(src,P,floor){
  var w=src.width,h=src.height,s=src.data,n=w*h;
  var lut=buildLUT(P);
  var t=P.temperature/100,ti=P.tint/100;
  var gr=(1+0.18*t)*(1+0.04*ti),gb=(1-0.18*t)*(1+0.04*ti),gg=1-0.10*ti;
  var dh=P.dehaze/100,sv=P.saturation/100+(dh>0?dh*0.2:0),vb=P.vibrance/100;
  var hs=new Float32Array(360),ss=new Float32Array(360),ls=new Float32Array(360),anyH=false,deg,k;
  for(deg=0;deg<360;deg++){
    var i0=0;
    for(k=0;k<8;k++){if(deg>=CENT[k])i0=k;}
    var i1=(i0+1)%8,c0=CENT[i0],c1=i1===0?360:CENT[i1],f=(deg-c0)/(c1-c0);
    var a=P.hsl[BANDS[i0]],b=P.hsl[BANDS[i1]];
    hs[deg]=(a[0]+(b[0]-a[0])*f)*0.3;
    ss[deg]=(a[1]+(b[1]-a[1])*f)/100;
    ls[deg]=(a[2]+(b[2]-a[2])*f)/100;
    if(a[0]||a[1]||a[2]||b[0]||b[1]||b[2])anyH=true;
  }
  var needHSL=anyH||sv!==0||vb!==0;
  var buf=new Float32Array(n*3),lum=new Float32Array(n);
  for(var i=0,j=0,p=0;i<n;i++,j+=3,p+=4){
    var r=lut[Math.min(255,(s[p]*gr)|0)],g=lut[Math.min(255,(s[p+1]*gg)|0)],bb=lut[Math.min(255,(s[p+2]*gb)|0)];
    if(dh>0){
      var f0=floor*dh*0.9,k0=255/(255-f0);
      r=Math.max(0,(r-f0)*k0);g=Math.max(0,(g-f0)*k0);bb=Math.max(0,(bb-f0)*k0);
    }else if(dh<0){
      var a0=-dh*0.35;
      r=r*(1-a0)+215*a0;g=g*(1-a0)+215*a0;bb=bb*(1-a0)+215*a0;
    }
    if(needHSL){
      var mx=Math.max(r,g,bb),mn=Math.min(r,g,bb),dc=mx-mn;
      if(dc>1){
        var l=(mx+mn)/510,den=1-Math.abs(2*l-1);
        if(den>0.001){
          var sat=dc/255/den;if(sat>1)sat=1;
          var hh;
          if(mx===r){hh=(g-bb)/dc;if(hh<0)hh+=6;}
          else if(mx===g)hh=(bb-r)/dc+2;
          else hh=(r-g)/dc+4;
          hh*=60;
          var di=hh|0;if(di>359)di=359;
          var wn=Math.min(1,sat*2.5);
          hh+=hs[di]*wn;if(hh<0)hh+=360;else if(hh>=360)hh-=360;
          var ns=sat*(1+ss[di]*wn);
          ns*=1+sv;
          if(vb>0){var sk=(hh>5&&hh<55)?0.5:1;ns*=1+vb*(1-ns)*1.2*sk;}
          else if(vb<0)ns*=1+vb;
          if(ns<0)ns=0;else if(ns>1)ns=1;
          var nl=l+ls[di]*0.2*wn;if(nl<0)nl=0;else if(nl>1)nl=1;
          var q=nl<0.5?nl*(1+ns):nl+ns-nl*ns,pp=2*nl-q,hn=hh/360;
          r=h2(pp,q,hn+1/3)*255;g=h2(pp,q,hn)*255;bb=h2(pp,q,hn-1/3)*255;
        }
      }
    }
    if(P.mono){var y0=0.299*r+0.587*g+0.114*bb;r=y0;g=y0;bb=y0;}
    buf[j]=r;buf[j+1]=g;buf[j+2]=bb;
    lum[i]=0.299*r+0.587*g+0.114*bb;
  }
  return {w:w,h:h,buf:buf,lum:lum};
}
function passB(A,P){
  var w=A.w,h=A.h,buf=A.buf,lum=A.lum;
  var out=new ImageData(w,h),o=out.data;
  var md=Math.max(w,h),cl=P.clarity/100,sh=P.sharpen/100,vg=P.vignette/100,gn=P.grain/100;
  var bc=null,bs=null;
  if(cl!==0){var rc=Math.max(3,Math.round(md*0.012));bc=boxBlur(boxBlur(lum,w,h,rc),w,h,rc);}
  if(sh>0){bs=boxBlur(lum,w,h,Math.max(1,Math.round(md*0.0016)));}
  var sc=P.grade.sh[1]>0?tintVec(P.grade.sh[0]):null,hc=P.grade.hi[1]>0?tintVec(P.grade.hi[0]):null;
  var sk=P.grade.sh[1]/100*0.22*255,hk=P.grade.hi[1]/100*0.22*255;
  var cx=w/2,cy=h/2,seed=2463534242;
  for(var y=0,i=0;y<h;y++){
    var dy=(y-cy)/cy;
    for(var x=0;x<w;x++,i++){
      var j=i*3,r=buf[j],g=buf[j+1],b=buf[j+2],L=lum[i],lw=L/255;
      if(cl!==0){var m=1-Math.pow(2*lw-1,2)*0.75;var dl=(L-bc[i])*cl*1.2*m;r+=dl;g+=dl;b+=dl;}
      if(bs){var ds=(L-bs[i])*sh*1.5;r+=ds;g+=ds;b+=ds;}
      if(sc){var ws=(1-lw)*(1-lw)*sk;r+=sc[0]*ws;g+=sc[1]*ws;b+=sc[2]*ws;}
      if(hc){var wh=lw*lw*hk;r+=hc[0]*wh;g+=hc[1]*wh;b+=hc[2]*wh;}
      if(vg!==0){
        var dx=(x-cx)/cx,dd=Math.sqrt(dx*dx+dy*dy)/1.4142,tt=(dd-0.35)/0.65;
        if(tt>0){if(tt>1)tt=1;var f=1+vg*0.75*tt*tt*(3-2*tt);r*=f;g*=f;b*=f;}
      }
      if(gn>0){
        seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
        var nz=(((seed>>>0)/4294967296)-0.5)*gn*45*(1-Math.pow(2*lw-1,2)*0.5);
        r+=nz;g+=nz;b+=nz;
      }
      var p=i*4;o[p]=r;o[p+1]=g;o[p+2]=b;o[p+3]=255;
    }
  }
  return out;
}
function render(src,P,floor){return passB(passA(src,P,floor),P);}
function hazeFloor(d){
  var hh=new Uint32Array(256),n=d.length/4,i;
  for(i=0;i<d.length;i+=4)hh[Math.min(d[i],d[i+1],d[i+2])]++;
  var acc=0,t=n*0.01;
  for(i=0;i<256;i++){acc+=hh[i];if(acc>=t)return i;}
  return 0;
}
/*ENGINE_END*/

// ---------------- رابط کاربری ----------------
var $=function(s){return document.querySelector(s);};
var ID=location.pathname.split("/").pop();
var P=blank(),AIP=blank(),PREV=null,ORIG=null,FLOOR=0,pending=false,curBand="red",HIST=[],ROWS=[];
var cv=$("#cv"),ctx=cv.getContext("2d"),hc=$("#hist"),hx=hc.getContext("2d");
var BAND_FA={red:"قرمز",orange:"نارنجی",yellow:"زرد",green:"سبز",aqua:"فیروزه‌ای",blue:"آبی",purple:"بنفش",magenta:"سرخابی"};
var BAND_COL={red:"#ff3b30",orange:"#ff9500",yellow:"#ffd60a",green:"#34c759",aqua:"#30d5c8",blue:"#0a84ff",purple:"#9b59ff",magenta:"#ff2d9b"};
var DEFS={
 light:[["exposure","نوردهی",-2,2,0.01],["contrast","کنتراست",-100,100,1],["highlights","هایلایت",-100,100,1],["shadows","سایه‌ها",-100,100,1],["whites","سفیدها",-100,100,1],["blacks","سیاه‌ها",-100,100,1]],
 color:[["temperature","دمای رنگ",-100,100,1],["tint","تینت",-100,100,1],["vibrance","ویبرنس",-100,100,1],["saturation","اشباع",-100,100,1]],
 detail:[["clarity","کلاریتی",-100,100,1],["dehaze","رفع مه",-100,100,1],["sharpen","شارپ",0,100,1]],
 fx:[["vignette","وینیت",-100,100,1],["grain","گرین",0,100,1],["fade","فید",0,100,1]]
};
var LOOKS=[
 ["🎬 سینمایی",{contrast:18,highlights:-20,shadows:10,saturation:-8,clarity:12,vignette:-18,grade:{sh:[200,30],hi:[35,22]},hsl:{blue:[-8,10,-10],orange:[0,8,4]}}],
 ["🎞 فیلم",{fade:35,contrast:-8,grain:30,temperature:8,saturation:-10,grade:{sh:[170,14],hi:[40,18]}}],
 ["🌅 طلایی",{temperature:30,tint:6,vibrance:20,highlights:-15,exposure:0.1,vignette:-10,grade:{hi:[40,25],sh:[20,10]}}],
 ["🌈 زنده",{vibrance:35,saturation:12,contrast:14,clarity:18,dehaze:12}],
 ["🤍 مات",{fade:45,contrast:-12,saturation:-12,blacks:20,highlights:-10}],
 ["⚫ سیاه‌وسفید",{mono:1,contrast:25,clarity:20,vignette:-15,grain:20}],
 ["❄️ سرد",{temperature:-25,tint:-4,contrast:10,saturation:-6,grade:{sh:[215,22]}}]
];
var PANELS={},TABBTN={};
function toast(t){var e=$("#toast");e.textContent=t;e.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(function(){e.style.display="none";},2800);}
function status(t){$("#status").textContent=t;}
function clone(o){return JSON.parse(JSON.stringify(o));}
function schedule(){
  if(pending||!PREV)return;
  pending=true;
  requestAnimationFrame(function(){pending=false;draw();});
}
function draw(){
  var out=render(PREV.data,P,FLOOR);
  ctx.putImageData(out,0,0);
  drawHist(out.data);
}
function drawHist(d){
  var hr=new Uint32Array(256),hg=new Uint32Array(256),hb=new Uint32Array(256),i,mx=1;
  for(i=0;i<d.length;i+=16){hr[d[i]]++;hg[d[i+1]]++;hb[d[i+2]]++;}
  for(i=2;i<254;i++)mx=Math.max(mx,hr[i],hg[i],hb[i]);
  hx.clearRect(0,0,220,72);
  hx.globalCompositeOperation="lighter";
  var cols=["rgba(255,60,60,.55)","rgba(60,255,90,.55)","rgba(70,120,255,.55)"],arr=[hr,hg,hb];
  for(var c=0;c<3;c++){
    hx.fillStyle=cols[c];
    for(i=0;i<256;i++){var v=Math.min(1,arr[c][i]/mx)*70;hx.fillRect(i*220/256,72-v,1.2,v);}
  }
  hx.globalCompositeOperation="source-over";
}
function row(parent,label,min,max,step,get,set){
  var d=document.createElement("div");d.className="row";
  var top=document.createElement("div");top.className="top";
  var lb=document.createElement("span");lb.textContent=label;
  var val=document.createElement("b");
  var rs=document.createElement("button");rs.className="rs";rs.textContent="↺";
  top.appendChild(lb);top.appendChild(val);top.appendChild(rs);
  var inp=document.createElement("input");inp.type="range";inp.min=min;inp.max=max;inp.step=step;
  d.appendChild(top);d.appendChild(inp);parent.appendChild(d);
  var r={sync:function(){var v=get();inp.value=v;val.textContent=Math.round(v*100)/100;}};
  inp.addEventListener("input",function(){var v=parseFloat(inp.value);set(v);val.textContent=Math.round(v*100)/100;schedule();});
  rs.addEventListener("click",function(){set(0);r.sync();schedule();});
  ROWS.push(r);r.sync();
}
function syncAll(){for(var i=0;i<ROWS.length;i++)ROWS[i].sync();}
function mkPanel(id){var d=document.createElement("div");d.className="panel";$("#panels").appendChild(d);PANELS[id]=d;return d;}
function showTab(id){
  for(var k in PANELS){PANELS[k].className="panel"+(k===id?" on":"");TABBTN[k].className=k===id?"on":"";}
}
function kv(key){return [function(){return P[key];},function(v){P[key]=v;}];}
function addTab(id,label){
  var b=document.createElement("button");b.textContent=label;b.addEventListener("click",function(){showTab(id);});
  $("#tabs").appendChild(b);TABBTN[id]=b;
}
function addBubble(cls,text){
  var m=$("#msgs"),b=document.createElement("div");b.className="b "+cls;b.textContent=text;m.appendChild(b);m.scrollTop=m.scrollHeight;return b;
}
function sendChat(text){
  text=(text||"").trim();if(!text)return;
  addBubble("u",text);
  var hist=HIST.slice(-6);
  HIST.push({role:"user",content:text});
  var tmp=addBubble("a","...");
  fetch("/api/chat/"+ID,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text,history:hist,current:P})})
  .then(function(r){return r.json();})
  .then(function(j){
    if(j.error){tmp.textContent="❌ "+j.error;return;}
    tmp.textContent=j.reply+(j.changed?"\n🎛 تنظیمات اعمال شد":"");
    HIST.push({role:"assistant",content:j.reply});
    if(j.changed&&j.preset){P=blank();applyPartial(P,j.preset);syncAll();schedule();}
  }).catch(function(e){tmp.textContent="❌ "+e.message;});
}
function exportBlob(cb){
  status("در حال ساخت خروجی نهایی...");
  setTimeout(function(){
    try{
      var W=ORIG.naturalWidth,H=ORIG.naturalHeight;
      var c=document.createElement("canvas");c.width=W;c.height=H;
      var x=c.getContext("2d");x.drawImage(ORIG,0,0);
      var src=x.getImageData(0,0,W,H);
      x.putImageData(render(src,P,FLOOR),0,0);
      c.toBlob(function(b){status("آماده");cb(b);},"image/jpeg",0.93);
    }catch(e){status("خطا");toast("❌ "+e.message);}
  },50);
}

function build(){
  addTab("ai","✨ هوش مصنوعی");addTab("light","☀️ نور");addTab("color","🎨 رنگ");addTab("hsl","🌈 HSL");addTab("detail","🔍 جزئیات");addTab("fx","🎞 افکت");addTab("chat","💬 چت");
  // AI
  var pa=mkPanel("ai");
  pa.innerHTML='<div class="note" id="aiNote"></div><div class="note" id="aiDesc"></div>';
  var b1=document.createElement("button");b1.className="tg";b1.textContent="↩️ برگشت به پریست هوش مصنوعی";
  b1.addEventListener("click",function(){P=clone(AIP);syncAll();schedule();toast("پریست AI اعمال شد");});
  var b2=document.createElement("button");b2.className="tg";b2.textContent="📋 کپی پریست (JSON)";
  b2.addEventListener("click",function(){
    var t=JSON.stringify(P);
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast("کپی شد ✅");},function(){window.prompt("کپی کن:",t);});}
    else window.prompt("کپی کن:",t);
  });
  pa.appendChild(b1);pa.appendChild(b2);
  // سادهها
  var names=["light","color","detail","fx"];
  for(var n=0;n<names.length;n++){
    var pn=mkPanel(names[n]),defs=DEFS[names[n]];
    for(var i=0;i<defs.length;i++){var d=defs[i],g=kv(d[0]);row(pn,d[1],d[2],d[3],d[4],g[0],g[1]);}
  }
  // رنگ: سیاه‌وسفید
  var mono=document.createElement("button");mono.className="tg";mono.textContent="⚫ سیاه‌وسفید";
  mono.addEventListener("click",function(){P.mono=P.mono?0:1;ROWS_MONO.sync();schedule();});
  PANELS.color.appendChild(mono);
  var ROWS_MONO={sync:function(){mono.className="tg"+(P.mono?" on":"");}};
  ROWS.push(ROWS_MONO);ROWS_MONO.sync();
  // رنگ‌بندی سایه/هایلایت
  var pf=PANELS.fx,gt=document.createElement("div");gt.className="note";gt.textContent="🎨 رنگ‌بندی (Color Grading)";pf.appendChild(gt);
  var gdefs=[["سایه‌ها: رنگ (هیو)","sh",0,360],["سایه‌ها: شدت","sh",1,100],["هایلایت‌ها: رنگ (هیو)","hi",0,360],["هایلایت‌ها: شدت","hi",1,100]];
  gdefs.forEach(function(q){row(pf,q[0],0,q[3],1,function(){return P.grade[q[1]][q[2]];},function(v){P.grade[q[1]][q[2]]=v;});});
  // HSL
  var ph=PANELS.hsl,chips=document.createElement("div");chips.className="chips";ph.appendChild(chips);
  BANDS.forEach(function(bn){
    var bt=document.createElement("button");bt.innerHTML='<span class="dot" style="background:'+BAND_COL[bn]+'"></span>'+BAND_FA[bn];
    bt.addEventListener("click",function(){curBand=bn;chipSync();syncAll();});
    bt.setAttribute("data-b",bn);chips.appendChild(bt);
  });
  function chipSync(){var cs=chips.children;for(var i=0;i<cs.length;i++)cs[i].className=cs[i].getAttribute("data-b")===curBand?"on":"";}
  chipSync();
  ["هیو (Hue)","اشباع (Saturation)","روشنایی (Luminance)"].forEach(function(lb,idx){
    row(ph,lb,-100,100,1,function(){return P.hsl[curBand][idx];},function(v){P.hsl[curBand][idx]=v;});
  });
  // چت
  var pc=mkPanel("chat");
  pc.innerHTML='<div id="msgs"></div><div class="chips" id="sug"></div><div id="cin"><input id="ci" placeholder="درباره‌ی عکس بپرس یا ویرایش بخواه..."><button id="cs">ارسال</button></div>';
  ["گرم‌ترش کن","سینمایی‌ترش کن","آسمون آبی‌تر","کنتراست کمتر","پوست طبیعی‌تر","روشن‌ترش کن"].forEach(function(t){
    var bt=document.createElement("button");bt.textContent=t;bt.addEventListener("click",function(){sendChat(t);});$("#sug").appendChild(bt);
  });
  $("#cs").addEventListener("click",function(){var i=$("#ci");sendChat(i.value);i.value="";});
  $("#ci").addEventListener("keydown",function(e){if(e.key==="Enter"){var i=$("#ci");sendChat(i.value);i.value="";}});
  addBubble("a","سلام! درباره‌ی عکست هرچی خواستی بپرس، یا بگو چی رو عوض کنم (مثلاً «سایه‌ها رو روشن‌تر کن» یا «رنگ سبزها رو طبیعی‌تر کن») 🙂");
  // پریست‌های آماده
  LOOKS.forEach(function(lk){
    var bt=document.createElement("button");bt.textContent=lk[0];
    bt.addEventListener("click",function(){P=blank();applyPartial(P,lk[1]);syncAll();schedule();toast("پریست «"+lk[0]+"» اعمال شد");});
    $("#looks").appendChild(bt);
  });
  showTab("ai");
}

function loadImg(u){return new Promise(function(res,rej){var i=new Image();i.onload=function(){res(i);};i.onerror=function(){rej(new Error("بارگذاری عکس ناموفق بود"));};i.src=u;});}

function start(){
  build();
  Promise.all([fetch("/api/state/"+ID).then(function(r){return r.json();}),loadImg("/api/img/"+ID)]).then(function(a){
    var st=a[0];ORIG=a[1];
    if(st.error){status("❌");toast(st.error);return;}
    P=blank();applyPartial(P,st.preset||{});AIP=clone(P);
    $("#aiNote").textContent="🎛 "+(st.note||"پریست هوش مصنوعی اعمال شد");
    $("#aiDesc").textContent="📷 "+(st.desc||"—");
    var W=ORIG.naturalWidth,H=ORIG.naturalHeight,sc=Math.min(1,1000/Math.max(W,H));
    var pw=Math.max(1,Math.round(W*sc)),ph=Math.max(1,Math.round(H*sc));
    var pc=document.createElement("canvas");pc.width=pw;pc.height=ph;
    var px=pc.getContext("2d");px.drawImage(ORIG,0,0,pw,ph);
    PREV={w:pw,h:ph,data:px.getImageData(0,0,pw,ph)};
    FLOOR=hazeFloor(PREV.data.data);
    cv.width=pw;cv.height=ph;
    syncAll();draw();status(W+"×"+H);
  }).catch(function(e){status("❌");toast(e.message);});
}

var cmp=$("#bCmp");
function showOrig(){if(PREV)ctx.putImageData(PREV.data,0,0);}
cmp.addEventListener("pointerdown",showOrig);
cmp.addEventListener("pointerup",function(){schedule();});
cmp.addEventListener("pointerleave",function(){schedule();});
$("#bReset").addEventListener("click",function(){P=blank();syncAll();schedule();toast("همه‌چیز ریست شد");});
$("#bSend").addEventListener("click",function(){
  exportBlob(function(b){
    toast("در حال ارسال...");
    fetch("/api/send/"+ID,{method:"POST",headers:{"Content-Type":"image/jpeg"},body:b})
    .then(function(r){return r.json();})
    .then(function(j){toast(j.ok?"✅ برای ربات فرستاده شد؛ روبیکا رو چک کن":"❌ "+(j.error||"خطا"));})
    .catch(function(e){toast("❌ "+e.message);});
  });
});
$("#bDl").addEventListener("click",function(){
  exportBlob(function(b){
    var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="edited.jpg";document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},4000);
  });
});
start();
})();
</script></body></html>`;
