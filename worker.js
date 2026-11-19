// ربات ویرایش عکس روبیکا - Cloudflare Worker
// قابلیت‌ها: ۱) پریست هوشمند (شبیه لایت‌روم) ۲) حذف بک‌گراند
// تنها چیزی که باید توی Secrets بذاری: RUBIKA_TOKEN

const API = "https://botapi.rubika.ir/v3/";

// مدل‌های بینایی Workers AI (اگه اولی جواب نداد، دومی امتحان می‌شه)
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

const WELCOME =
  "سلام 👋 من دستیار هوشمندتم!\n\n💬 هر سؤالی داری بنویس، باهات حرف می‌زنم\n✨ عکس بفرست تا یه پریست مخصوص همون عکس بسازم و اعمال کنم\n✂️ یا بک‌گراند عکس رو حذف کنم\n\n🗑 برای پاک کردن حافظه‌ی گفتگو: /new";

let TOKEN = "";
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
    { buttons: [{ id: "enhance", type: "Simple", button_text: "✨ بهبود هوشمند (پریست)" }] },
    { buttons: [{ id: "bg", type: "Simple", button_text: "✂️ حذف بک‌گراند" }] },
    { buttons: [{ id: "both", type: "Simple", button_text: "✨✂️ هر دو" }] },
  ],
};

// ---------- ابزارهای کمکی ----------
async function hookKey(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + token));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
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

function isImage(file) {
  const name = String(file.file_name || "").toLowerCase();
  const m = name.match(/\.([a-z0-9]+)$/);
  if (!m) return true;
  return ["jpg", "jpeg", "png", "webp"].includes(m[1]);
}

// ---------- پریست هوشمند ----------
function parsePreset(out) {
  let o = out;
  if (typeof o === "string") {
    const m = o.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { o = JSON.parse(m[0]); } catch (e) { return null; }
  }
  if (!o || typeof o !== "object") return null;
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

async function askModel(env, mdl, b64) {
  const body = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: PROMPT },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
      ],
    }],
  };
  body[mdl.tokensKey] = mdl.tokens;
  const r = await env.AI.run(mdl.id, body);
  if (!r) return null;
  if (r.response !== undefined && r.response !== null) return r.response;
  if (r.choices && r.choices[0] && r.choices[0].message) return r.choices[0].message.content;
  return typeof r === "string" ? r : null;
}

async function makePreset(env, buf) {
  try {
    // نسخه‌ی کوچک عکس برای تحلیل هوش مصنوعی
    const res = (await env.IMAGES.input(new Blob([buf]).stream())
      .transform({ width: 640, height: 640, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 70 })).response();
    const b64 = toB64(new Uint8Array(await res.arrayBuffer()));
    for (const mdl of AI_MODELS) {
      try {
        const p = parsePreset(await askModel(env, mdl, b64));
        if (p) return p;
      } catch (e) { console.log("AI " + mdl.id + ": " + e.message); }
    }
  } catch (e) { console.log("preset error: " + e.message); }
  return { ...DEFAULT_PRESET, note: "هوش مصنوعی جواب نداد؛ یه پریست ملایم عمومی اعمال شد." };
}

// ---------- پردازش اصلی ----------
async function runAction(env, chat, action) {
  const raw = await env.STATE.get("u:" + chat);
  if (!raw) return send(chat, "اول یه عکس بفرست 📷");
  const s = JSON.parse(raw);
  await send(chat, "⏳ در حال پردازش... چند ثانیه صبر کن");

  const info = await rub("getFile", { file_id: s.id });
  const url = info.data && info.data.download_url;
  if (!url) throw new Error("لینک دانلود عکس پیدا نشد");
  const dl = await fetch(url);
  if (!dl.ok) throw new Error("دانلود عکس ناموفق بود (" + dl.status + ")");
  const buf = await dl.arrayBuffer();

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
  "تو می‌تونی عکس‌ها رو هم ویرایش کنی (پریست هوشمند و حذف بک‌گراند): اگه کاربر خواست، بهش بگو عکسش رو بفرسته.";
const HISTORY_LIMIT = 8; // تعداد پیام‌هایی که یادش می‌مونه

async function chatReply(env, chat, userText) {
  let hist = [];
  try { hist = JSON.parse((await env.STATE.get("h:" + chat)) || "[]"); } catch (e) {}
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...hist, { role: "user", content: userText.slice(0, 2000) }];
  let answer = "";
  for (const mdl of AI_MODELS) {
    try {
      const body = { messages };
      body[mdl.tokensKey] = mdl.tokens + 400;
      const r = await env.AI.run(mdl.id, body);
      const out = r && (r.response !== undefined && r.response !== null ? r.response
        : r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : "");
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

// ---------- ورودی Worker ----------
const txt = (s, status) => new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env, ctx) {
    TOKEN = env.RUBIKA_TOKEN || "";
    if (!TOKEN) return txt("RUBIKA_TOKEN توی Secrets تنظیم نشده.", 500);
    const u = new URL(request.url);
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
