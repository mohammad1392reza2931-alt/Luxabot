// ربات ویرایش عکس روبیکا (نسخه‌ی حرفه‌ای) - Cloudflare Worker
// فقط یک Secret لازمه: RUBIKA_TOKEN

const API = "https://botapi.rubika.ir/v3/";

// مدل‌های متنی/بینایی (اگه اولی جواب نداد، دومی امتحان می‌شه)
const AI_MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", tokensKey: "max_tokens", tokens: 700 },
  { id: "@cf/google/gemma-4-26b-a4b-it", tokensKey: "max_completion_tokens", tokens: 1500 },
];
const EDIT_MODEL = "@cf/black-forest-labs/flux-2-klein-4b"; // ویرایش عکس با دستور متنی

const WELCOME =
  "سلام 👋 من دستیار هوشمند و استودیوی عکس تو هستم!\n\n" +
  "💬 هر سؤالی داری بنویس، باهات حرف می‌زنم\n" +
  "📷 عکس بفرست: خودم تحلیلش می‌کنم، یه پریست حرفه‌ای مخصوص همون عکس می‌سازم و اعمال می‌کنم. بعدش هم می‌تونی درباره‌ی عکس ازم سؤال بپرسی. ابزارهای بیشتر:\n" +
  "🎨 استایل‌های سینمایی، وینتیج، سیاه‌وسفید و...\n" +
  "✂️ حذف / بلور / تغییر بک‌گراند\n" +
  "🔍 افزایش وضوح ۲ برابر\n" +
  "🪄 ویرایش با دستور (مثلاً «ماشین پشتی رو حذف کن»)\n\n" +
  "🗑 پاک کردن حافظه‌ی گفتگو: /new  |  نمایش منوی عکس: /menu";

let TOKEN = "";
const RECENT = new Map();

// ================= روبیکا =================
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
const btn = (id, text) => ({ id, type: "Simple", button_text: text });
const KEY_MAIN = {
  rows: [
    { buttons: [btn("enh", "🔄 پریست جدید"), btn("menu:sty", "🎨 استایل‌ها")] },
    { buttons: [btn("bg", "✂️ حذف بک‌گراند"), btn("blur", "🌫 پرتره (بلور)")] },
    { buttons: [btn("menu:bg", "🖼 تغییر بک‌گراند"), btn("up", "🔍 وضوح ۲×")] },
    { buttons: [btn("edit", "🪄 ویرایش با دستور (حذف اشیا و...)")] },
  ],
};

// ================= ابزارهای کمکی =================
const bs = (u) => new Blob([u]).stream();
async function hookKey(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hook:" + token));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function num(v, lo, hi, def) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, v));
}
const pct = (v) => { const p = Math.round((v - 1) * 100); return (p > 0 ? "+" : "") + p + "%"; };
function isImage(file) {
  const m = String(file.file_name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return !m || ["jpg", "jpeg", "png", "webp"].includes(m[1]);
}

// ================= ساخت PNG کوچک (برای لایه‌های رنگی) =================
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(u8) { let a = 1, b = 0; for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
// ctype: 0=خاکستری، 2=RGB، 6=RGBA
function makePng(w, h, ctype, bpp, fill) {
  const row = 1 + w * bpp, raw = new Uint8Array(h * row);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fill(x, y, raw, y * row + 1 + x * bpp);
  const blocks = Math.ceil(raw.length / 65535), z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535)), n = part.length;
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = n & 255; z[o++] = n >> 8; z[o++] = ~n & 255; z[o++] = (~n >> 8) & 255;
    z.set(part, o); o += n;
  }
  new DataView(z.buffer).setUint32(o, adler32(raw));
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = ctype;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let q = 0; for (const p of parts) { out.set(p, q); q += p.length; }
  return out;
}
function solidPng(r, g, b) {
  return makePng(1, 1, 2, 3, (x, y, d, i) => { d[i] = r; d[i + 1] = g; d[i + 2] = b; });
}
function gradientPng(stops) {
  const N = 64;
  return makePng(1, N, 2, 3, (x, y, d, i) => {
    const t = y / (N - 1) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    const a = stops[Math.max(0, k)], c = stops[Math.min(stops.length - 1, k + 1)] || a;
    for (let j = 0; j < 3; j++) d[i + j] = Math.round(a[j] + (c[j] - a[j]) * f);
  });
}
let _vig, _grain;
function vignettePng() {
  if (!_vig) _vig = makePng(32, 32, 6, 4, (x, y, d, i) => {
    const dx = (x + 0.5) / 32 - 0.5, dy = (y + 0.5) / 32 - 0.5, r = Math.sqrt(dx * dx + dy * dy) / 0.7071;
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round(255 * 0.9 * Math.pow(Math.max(0, (r - 0.4) / 0.6), 1.6));
  });
  return _vig;
}
function grainPng() {
  if (!_grain) { let s = 12345; _grain = makePng(64, 64, 0, 1, (x, y, d, i) => { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s >>> 24; }); }
  return _grain;
}

// ================= هوش مصنوعی (متن/بینایی) =================
function outText(r) {
  if (!r) return "";
  if (r.response !== undefined && r.response !== null) return r.response;
  if (r.choices && r.choices[0] && r.choices[0].message) return r.choices[0].message.content || "";
  return typeof r === "string" ? r : "";
}
async function llm(env, messages, extraTokens) {
  for (const mdl of AI_MODELS) {
    try {
      const body = { messages };
      body[mdl.tokensKey] = mdl.tokens + (extraTokens || 0);
      const out = outText(await env.AI.run(mdl.id, body));
      if (out && (typeof out === "object" || String(out).trim())) return out;
    } catch (e) { console.log("LLM " + mdl.id + ": " + e.message); }
  }
  return "";
}

// ================= پریست حرفه‌ای =================
const STYLES = {
  cinema: { label: "🎬 سینمایی", hint: "cinematic teal-and-orange look: slightly cool shadows, warm skin tones, moderate contrast, a little fade, subtle vignette",
    def: { brightness: 1.0, contrast: 1.15, gamma: 1.0, saturation: 1.05, sharpen: 1, warmth: 0.15, tint: -0.1, fade: 0.2, vignette: 0.35, grain: 0.1 } },
  warm: { label: "🌅 گرم و نوستالژیک", hint: "warm golden nostalgic look: warm temperature, soft contrast, slight fade, light grain",
    def: { brightness: 1.05, contrast: 1.05, gamma: 1.1, saturation: 1.1, sharpen: 0.5, warmth: 0.6, tint: 0.05, fade: 0.2, vignette: 0.2, grain: 0.15 } },
  cool: { label: "❄️ سرد و مدرن", hint: "clean cool modern look: cool temperature, crisp sharpness, slightly desaturated, clean contrast",
    def: { brightness: 1.0, contrast: 1.12, gamma: 1.0, saturation: 0.9, sharpen: 1.5, warmth: -0.5, tint: 0, fade: 0, vignette: 0.1, grain: 0 } },
  vintage: { label: "📼 وینتیج / فیلم", hint: "vintage analog film look: faded matte blacks, warm tint, reduced saturation, visible grain, vignette",
    def: { brightness: 1.03, contrast: 0.95, gamma: 1.1, saturation: 0.8, sharpen: 0, warmth: 0.4, tint: 0.15, fade: 0.6, vignette: 0.45, grain: 0.5 } },
  bw: { label: "⚫ سیاه‌وسفید هنری", hint: "artistic black and white: strong contrast, deep blacks, grain and vignette",
    def: { brightness: 1.0, contrast: 1.25, gamma: 1.0, saturation: 0, sharpen: 1.5, warmth: 0, tint: 0, fade: 0.05, vignette: 0.4, grain: 0.3 } },
  vivid: { label: "🌈 شاداب", hint: "vivid punchy look: high saturation and contrast, sharp and bright",
    def: { brightness: 1.05, contrast: 1.2, gamma: 1.05, saturation: 1.35, sharpen: 2, warmth: 0.1, tint: 0, fade: 0, vignette: 0.1, grain: 0 } },
};
const BASE_DEFAULT = { brightness: 1.05, contrast: 1.1, gamma: 1.05, saturation: 1.1, sharpen: 1, warmth: 0, tint: 0, fade: 0, vignette: 0.1, grain: 0 };
const PKEYS = ["brightness", "contrast", "gamma", "saturation", "sharpen", "warmth", "tint", "fade", "vignette", "grain"];

function presetPrompt(style) {
  return "You are a professional photo retoucher using Adobe Lightroom. Analyze this photo and choose global adjustments. " +
    "Reply with ONLY a JSON object, no other text, with these numeric keys: " +
    "brightness (exposure, 0.8 to 1.35, 1 = no change), contrast (0.85 to 1.3), " +
    "gamma (shadow/midtone lift, 0.8 to 1.4, above 1 brightens shadows), saturation (0 to 1.5, 1 = no change), " +
    "sharpen (0 to 4), warmth (-1 cool to +1 warm), tint (-1 green to +1 magenta), fade (0 to 1, matte lifted blacks), " +
    "vignette (0 to 1), grain (0 to 1), note (one short Persian sentence about what you changed and why), " +
    "and description (2 to 3 short Persian sentences: what the photo shows, its lighting, colors, mood and main technical problems). " +
    "Rules: dark photo -> raise brightness/gamma; overexposed -> lower; flat or hazy -> raise contrast; dull colors -> raise saturation; " +
    "wrong white balance -> fix with warmth/tint; soft -> raise sharpen. Be tasteful, avoid extreme values. " +
    "Style request: " + (style ? style.hint : "natural and realistic, just make the photo look professionally edited") + ".";
}
function parsePreset(out, style) {
  let o = out;
  if (typeof o === "string") {
    const m = o.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { o = JSON.parse(m[0]); } catch (e) { return null; }
  }
  if (!o || typeof o !== "object" || PKEYS.filter((k) => k in o).length < 3) return null;
  const p = {
    brightness: num(o.brightness, 0.8, 1.35, 1), contrast: num(o.contrast, 0.85, 1.3, 1), gamma: num(o.gamma, 0.8, 1.4, 1),
    saturation: num(o.saturation, 0, 1.5, 1), sharpen: num(o.sharpen, 0, 4, 0), warmth: num(o.warmth, -1, 1, 0),
    tint: num(o.tint, -1, 1, 0), fade: num(o.fade, 0, 1, 0), vignette: num(o.vignette, 0, 1, 0), grain: num(o.grain, 0, 1, 0),
    note: typeof o.note === "string" ? o.note.slice(0, 200) : "",
    desc: typeof o.description === "string" ? o.description.slice(0, 500) : "",
  };
  return p;
}
async function makeThumb(env, buf) {
  const small = await (await env.IMAGES.input(bs(buf)).transform({ width: 640, height: 640, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 70 })).response().arrayBuffer();
  return toB64(new Uint8Array(small));
}
async function makePreset(env, thumb, styleKey) {
  const style = STYLES[styleKey];
  let p = null;
  try {
    const out = await llm(env, [{
      role: "user",
      content: [
        { type: "text", text: presetPrompt(style) },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + thumb } },
      ],
    }]);
    p = parsePreset(out, style);
  } catch (e) { console.log("preset error: " + e.message); }
  if (!p) p = { ...(style ? style.def : BASE_DEFAULT), note: "هوش مصنوعی جواب نداد؛ پریست آماده اعمال شد.", desc: "" };
  if (styleKey === "bw") { p.saturation = 0; p.warmth = 0; p.tint = 0; }
  return p;
}
function describe(p) {
  const L = [], d = (v) => Math.abs(v - 1) > 0.02;
  if (d(p.brightness)) L.push("🔆 نور " + pct(p.brightness));
  if (d(p.contrast)) L.push("◐ کنتراست " + pct(p.contrast));
  if (d(p.gamma)) L.push("🌗 سایه‌ها " + pct(p.gamma));
  if (d(p.saturation)) L.push("🎨 رنگ‌ها " + (p.saturation === 0 ? "سیاه‌وسفید" : pct(p.saturation)));
  if (p.sharpen > 0.2) L.push("🔍 وضوح " + p.sharpen.toFixed(1));
  if (Math.abs(p.warmth) > 0.05) L.push("🌡 دما: " + (p.warmth > 0 ? "گرم‌تر " : "سردتر ") + Math.abs(Math.round(p.warmth * 100)) + "%");
  if (Math.abs(p.tint) > 0.05) L.push("🎚 تینت: " + (p.tint > 0 ? "مجنتا" : "سبز"));
  if (p.fade > 0.05) L.push("🌫 فید مات " + Math.round(p.fade * 100) + "%");
  if (p.vignette > 0.05) L.push("⚫ وینیت " + Math.round(p.vignette * 100) + "%");
  if (p.grain > 0.05) L.push("🎞 گرین فیلم " + Math.round(p.grain * 100) + "%");
  return (p.note ? p.note + "\n\n" : "") + L.join("\n");
}
async function renderLook(env, buf, p, fancy) {
  const MAX = 2048;
  const info = await env.IMAGES.info(bs(buf));
  const sc = Math.min(1, MAX / Math.max(info.width, info.height));
  const W = Math.ceil(info.width * sc), H = Math.ceil(info.height * sc);
  const adj = { brightness: p.brightness, contrast: p.contrast, gamma: p.gamma, saturation: p.saturation };
  if (p.sharpen > 0.05) adj.sharpen = p.sharpen;
  let img = env.IMAGES.input(bs(buf)).transform({ width: MAX, height: MAX, fit: "scale-down" }).transform(adj);
  if (fancy) {
    const layer = (png, opacity) => {
      img = img.draw(env.IMAGES.input(bs(png)).transform({ width: W, height: H, fit: "squeeze" }), { opacity, top: 0, left: 0 });
    };
    if (Math.abs(p.warmth) > 0.05) layer(p.warmth > 0 ? solidPng(255, 150, 40) : solidPng(50, 130, 255), Math.min(0.16, Math.abs(p.warmth) * 0.14));
    if (Math.abs(p.tint) > 0.05) layer(p.tint > 0 ? solidPng(255, 60, 200) : solidPng(60, 220, 90), Math.min(0.1, Math.abs(p.tint) * 0.08));
    if (p.fade > 0.05) layer(solidPng(196, 194, 200), Math.min(0.14, p.fade * 0.12));
    if (p.vignette > 0.05) layer(vignettePng(), Math.min(1, p.vignette));
    if (p.grain > 0.05) img = img.draw(env.IMAGES.input(bs(grainPng())), { opacity: Math.min(0.14, p.grain * 0.12), repeat: true });
  }
  return (await img.output({ format: "image/jpeg", quality: 92 })).response().arrayBuffer();
}
async function doEnhance(env, buf, styleKey, thumb, pre) {
  thumb = thumb || (await makeThumb(env, buf));
  const p = pre || (await makePreset(env, thumb, styleKey));
  let bytes, note = "";
  try { bytes = await renderLook(env, buf, p, true); }
  catch (e) {
    console.log("fancy failed: " + e.message);
    bytes = await renderLook(env, buf, p, false);
    note = "\n\n⚠️ لایه‌های رنگی پیشرفته (دما، وینیت، گرین) اعمال نشد.";
  }
  const title = styleKey && STYLES[styleKey] ? "استایل " + STYLES[styleKey].label : "✨ پریست حرفه‌ای ساخته و اعمال شد";
  return { bytes, mime: "image/jpeg", name: "result.jpg", asFile: false, preset: p, thumb,
    caption: title + "\n\n" + describe(p) + note };
}

// ================= بک‌گراند =================
const BGS = {
  white: { label: "⚪ سفید", stops: [[255, 255, 255]] },
  black: { label: "⚫ مشکی", stops: [[0, 0, 0]] },
  blue: { label: "🔵 گرادیان آبی-بنفش", stops: [[30, 70, 210], [130, 60, 220]] },
  sunset: { label: "🌇 گرادیان غروب", stops: [[255, 150, 60], [210, 55, 120], [60, 30, 110]] },
  green: { label: "🟢 سبز استودیویی", stops: [[30, 160, 100], [10, 90, 65]] },
};
async function segmentPng(env, buf) {
  return (await env.IMAGES.input(bs(buf)).transform({ width: 2048, height: 2048, fit: "scale-down" })
    .transform({ segment: "foreground" }).output({ format: "image/png" })).response().arrayBuffer();
}
async function doBg(env, buf, kind, arg) {
  const fg = await segmentPng(env, buf);
  if (kind === "bg") return { bytes: fg, mime: "image/png", name: "result.png", asFile: true, caption: "✂️ بک‌گراند حذف شد (PNG با پس‌زمینه‌ی شفاف)" };
  const info = await env.IMAGES.info(bs(fg));
  const W = info.width, H = info.height;
  let img;
  if (kind === "blur") {
    const r = Math.max(10, Math.min(60, Math.round(Math.max(W, H) / 70)));
    img = env.IMAGES.input(bs(buf)).transform({ width: 2048, height: 2048, fit: "scale-down" }).transform({ blur: r });
  } else {
    const bg = BGS[arg] || BGS.white;
    img = env.IMAGES.input(bs(gradientPng(bg.stops))).transform({ width: W, height: H, fit: "squeeze" });
  }
  const bytes = await (await img.draw(bs(fg), { top: 0, left: 0 }).output({ format: "image/jpeg", quality: 92 })).response().arrayBuffer();
  const cap = kind === "blur" ? "🌫 بک‌گراند بلور شد (حالت پرتره)" : "🖼 بک‌گراند عوض شد: " + (BGS[arg] || BGS.white).label;
  return { bytes, mime: "image/jpeg", name: "result.jpg", asFile: false, caption: cap };
}

// ================= افزایش وضوح =================
async function doUpscale(env, buf) {
  const info = await env.IMAGES.info(bs(buf));
  const f = Math.min(2, 4096 / Math.max(info.width, info.height));
  if (f < 1.05) throw new Error("این عکس از قبل خیلی بزرگه (بیشتر از ۴۰۹۶ پیکسل)");
  const w = Math.round(info.width * f), h = Math.round(info.height * f);
  const bytes = await (await env.IMAGES.input(bs(buf)).transform({ width: w, height: h, fit: "contain" })
    .transform({ sharpen: 1.5 }).output({ format: "image/jpeg", quality: 95 })).response().arrayBuffer();
  return { bytes, mime: "image/jpeg", name: "result.jpg", asFile: true,
    caption: "🔍 اندازه‌ی عکس از " + info.width + "×" + info.height + " به " + w + "×" + h + " رسید و وضوحش بیشتر شد.\n(این بزرگ‌نمایی با الگوریتم است، نه هوش مصنوعی؛ جزئیات جدید نمی‌سازه.)" };
}

// ================= ویرایش با دستور (حذف اشیا و...) =================
async function doAiEdit(env, buf, instruction) {
  let en = await llm(env, [
    { role: "system", content: "Convert the user's image-editing request (Persian or English) into one short, precise English instruction for an AI image editor. Reply with the instruction only." },
    { role: "user", content: instruction.slice(0, 500) },
  ], -250);
  en = typeof en === "string" && en.trim() ? en.trim().replace(/^["']|["']$/g, "") : instruction;
  const small = await (await env.IMAGES.input(bs(buf)).transform({ width: 504, height: 504, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 92 })).response().arrayBuffer();
  const inf = await env.IMAGES.info(bs(small));
  const sc = 1024 / Math.max(inf.width, inf.height);
  const dim = (v) => Math.max(256, Math.min(1920, Math.round((v * sc) / 16) * 16));
  const form = new FormData();
  form.append("prompt", en + ". Keep everything else in the image unchanged.");
  form.append("input_image_0", new Blob([small], { type: "image/jpeg" }), "in.jpg");
  form.append("width", String(dim(inf.width)));
  form.append("height", String(dim(inf.height)));
  const fr = new Response(form);
  const res = await env.AI.run(EDIT_MODEL, { multipart: { body: fr.body, contentType: fr.headers.get("content-type") } });
  if (!res || typeof res.image !== "string") throw new Error("مدل ویرایش خروجی نداد");
  const bytes = fromB64(res.image);
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return { bytes, mime: jpg ? "image/jpeg" : "image/png", name: jpg ? "edit.jpg" : "edit.png", asFile: false,
    caption: "🪄 ویرایش انجام شد\nدستور: " + en + "\n\n(این روش عکس رو دوباره می‌سازه، پس ممکنه جزئیات یا چهره‌ها کمی تغییر کنن.)" };
}

// ================= گفتگوی دستیار =================
const SYSTEM_PROMPT =
  "تو یک دستیار روزمره‌ی صمیمی و کاربلد هستی که داخل روبیکا کار می‌کنی. به فارسی روان و محاوره‌ای جواب بده، " +
  "کوتاه و مفید باش (مگه اینکه کاربر توضیح کامل بخواد). اگه چیزی رو نمی‌دونی صادقانه بگو. " +
  "تو یک استودیوی ویرایش عکس هم هستی (بهبود حرفه‌ای، استایل، حذف و تغییر بک‌گراند، افزایش وضوح، ویرایش با دستور): اگه کاربر خواست، بهش بگو عکسش رو بفرسته.";
const HISTORY_LIMIT = 8;
async function chatReply(env, chat, userText) {
  let hist = [];
  try { hist = JSON.parse((await env.STATE.get("h:" + chat)) || "[]"); } catch (e) {}
  const ss = await getSession(env, chat);
  let sys = SYSTEM_PROMPT, content = userText.slice(0, 2000);
  if (ss && ss.thumb) {
    sys += "\n\n[کاربر اخیراً عکسی فرستاده و تو اون رو تحلیل و ویرایش کردی. تحلیل تو: " + (ss.desc || "—") +
      "\nپریست اعمال‌شده:\n" + (ss.preset || "—") +
      "\nتصویر عکس به پیام آخر کاربر ضمیمه شده. اگه سؤالش درباره‌ی عکسه، با نگاه به تصویر جواب بده (نور، رنگ، ترکیب‌بندی، دلیل انتخاب پریست، پیشنهاد برای ویرایش بهتر).]";
    content = [{ type: "text", text: content }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + ss.thumb } }];
  }
  const out = await llm(env, [{ role: "system", content: sys }, ...hist, { role: "user", content }], 400);
  const answer = typeof out === "string" ? out.trim() : "";
  if (!answer) throw new Error("هوش مصنوعی جواب نداد (شاید سهمیه‌ی رایگان امروز تموم شده)");
  hist.push({ role: "user", content: userText.slice(0, 600) }, { role: "assistant", content: answer.slice(0, 900) });
  await env.STATE.put("h:" + chat, JSON.stringify(hist.slice(-HISTORY_LIMIT)), { expirationTtl: 86400 });
  return answer.slice(0, 3800);
}

// ================= کنترل اصلی =================
async function getSession(env, chat) {
  const raw = await env.STATE.get("u:" + chat);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function downloadById(fileId) {
  const info = await rub("getFile", { file_id: fileId });
  const url = info.data && info.data.download_url;
  if (!url) throw new Error("لینک دانلود عکس پیدا نشد");
  const dl = await fetch(url);
  if (!dl.ok) throw new Error("دانلود عکس ناموفق بود (" + dl.status + ")");
  return dl.arrayBuffer();
}
async function downloadPhoto(env, chat) {
  const ss = await getSession(env, chat);
  return ss ? downloadById(ss.id) : null;
}
// عکس که برسه: تحلیل خودکار + ساخت پریست + اعمال
async function autoProcess(env, chat, fileId, st) {
  await send(chat, "📷 عکس رسید! در حال تحلیل و ساخت پریست حرفه‌ای... ⏳ (حدود ۳۰ ثانیه)");
  const buf = await downloadById(fileId);
  const thumb = await makeThumb(env, buf);
  const p = await makePreset(env, thumb, "");
  await env.STATE.put("u:" + chat, JSON.stringify({ id: fileId, thumb, desc: p.desc || "", preset: describe(p).slice(0, 700) }), { expirationTtl: 86400 });
  st.saved = true;
  const r = await doEnhance(env, buf, "", thumb, p);
  if (p.desc) r.caption = "🔎 تحلیل هوش مصنوعی:\n" + p.desc + "\n\n" + r.caption;
  await deliver(chat, r);
  await send(chat, "حالا می‌تونی درباره‌ی این عکس ازم سؤال بپرسی 💬 یا یکی از ابزارهای بیشتر رو بزنی 👇", KEY_MAIN);
}
async function deliver(chat, r) {
  const blob = new Blob([r.bytes], { type: r.mime });
  const fid = await upload(r.asFile ? "File" : "Image", blob, r.name);
  await rub("sendFile", { chat_id: chat, file_id: fid, text: r.caption + "\n\nبرای ویرایش بیشتر: /menu" });
}
function stylesKeypad() {
  const ks = Object.keys(STYLES).map((k) => btn("sty:" + k, STYLES[k].label));
  const rows = [];
  for (let i = 0; i < ks.length; i += 2) rows.push({ buttons: ks.slice(i, i + 2) });
  return { rows };
}
function bgKeypad() {
  const ks = Object.keys(BGS).map((k) => btn("bgc:" + k, BGS[k].label));
  const rows = [];
  for (let i = 0; i < ks.length; i += 2) rows.push({ buttons: ks.slice(i, i + 2) });
  return { rows };
}

async function runAction(env, chat, action) {
  const [kind, arg] = action.split(":");
  if (kind === "menu") return send(chat, arg === "sty" ? "یه استایل انتخاب کن 🎨" : "بک‌گراند جدید چی باشه؟ 🖼", arg === "sty" ? stylesKeypad() : bgKeypad());
  const ss = await getSession(env, chat);
  if (!ss) return send(chat, "اول یه عکس بفرست 📷");
  if (kind === "edit") {
    await env.STATE.put("m:" + chat, "edit", { expirationTtl: 600 });
    return send(chat, "🪄 دستورت رو بنویس (فارسی یا انگلیسی). مثلاً:\n• ماشین پشت سر رو حذف کن\n• آسمون رو غروب کن\n• عکس رو رنگی کن\n• عینک رو بردار");
  }
  await send(chat, "⏳ در حال پردازش... ممکنه تا ۳۰ ثانیه طول بکشه");
  const buf = await downloadById(ss.id);
  let r;
  if (kind === "enh") r = await doEnhance(env, buf, "", ss.thumb);
  else if (kind === "sty") r = await doEnhance(env, buf, arg, ss.thumb);
  else if (kind === "bg" || kind === "blur") r = await doBg(env, buf, kind);
  else if (kind === "bgc") r = await doBg(env, buf, "bgc", arg);
  else if (kind === "up") r = await doUpscale(env, buf);
  else return send(chat, "این دکمه رو نمی‌شناسم 🤔");
  await deliver(chat, r);
}

async function handle(env, m) {
  const chat = m.chat;
  try {
    if (m.button) return await runAction(env, chat, m.button);
    if (m.file) {
      if (!isImage(m.file)) return await send(chat, "فعلاً فقط عکس (jpg / png / webp) قبول می‌کنم 🙂");
      await env.STATE.delete("m:" + chat);
      const fid = m.file.file_id || m.file.id, st = { saved: false };
      try { return await autoProcess(env, chat, fid, st); }
      catch (e) {
        console.log("auto error: " + e.message);
        if (!st.saved) await env.STATE.put("u:" + chat, JSON.stringify({ id: fid }), { expirationTtl: 86400 });
        await send(chat, "❌ خطا در پردازش خودکار: " + e.message);
        return await send(chat, "از ابزارهای دستی استفاده کن 👇", KEY_MAIN);
      }
    }
    const t = (m.text || "").trim();
    if (!t || t === "/start" || t === "start") return await send(chat, WELCOME);
    if (t === "/new") {
      await env.STATE.delete("h:" + chat);
      await env.STATE.delete("m:" + chat);
      return await send(chat, "حافظه‌ی گفتگو پاک شد ✅");
    }
    if (t === "/menu") {
      if (!(await getSession(env, chat))) return await send(chat, "اول یه عکس بفرست 📷");
      return await send(chat, "چه کاری روی عکس انجام بدم؟", KEY_MAIN);
    }
    if ((await env.STATE.get("m:" + chat)) === "edit") {
      await env.STATE.delete("m:" + chat);
      const buf = await downloadPhoto(env, chat);
      if (!buf) return await send(chat, "عکس منقضی شده؛ دوباره بفرستش 📷");
      await send(chat, "🪄 در حال ویرایش... (۱۵ تا ۶۰ ثانیه)");
      return await deliver(chat, await doAiEdit(env, buf, t));
    }
    return await send(chat, await chatReply(env, chat, t));
  } catch (e) {
    console.log("handle error: " + e.message);
    try { await send(chat, "❌ خطا: " + e.message); } catch (x) {}
  }
}

// ================= خوندن آپدیت‌های روبیکا =================
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
    if (!m) { try { await env.STATE.put("dbg", JSON.stringify(it).slice(0, 1500)); } catch (e) {} continue; }
    if (m.ignore) continue;
    const k = m.chat + "|" + m.mid + "|" + m.button, now = Date.now();
    if (RECENT.get(k) && now - RECENT.get(k) < 20000) continue;
    RECENT.set(k, now);
    if (RECENT.size > 200) RECENT.clear();
    await handle(env, m);
  }
}

// ================= ورودی Worker =================
const txt = (s, status) => new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env, ctx) {
    TOKEN = env.RUBIKA_TOKEN || "";
    if (!TOKEN) return txt("RUBIKA_TOKEN توی Secrets تنظیم نشده.", 500);
    const u = new URL(request.url);
    const key = await hookKey(TOKEN);

    if (request.method === "POST") {
      if (!u.pathname.startsWith("/hook/" + key)) return txt("no", 403);
      let body;
      try { body = await request.json(); } catch (e) { return txt("ok"); }
      ctx.waitUntil(handleUpdate(env, body).catch((e) => console.log("update error: " + e.message)));
      return txt("ok");
    }
    if (u.pathname === "/setup") {
      const hook = u.origin + "/hook/" + key, lines = [];
      for (const type of ["ReceiveUpdate", "ReceiveInlineMessage"]) {
        try { lines.push(type + ": " + JSON.stringify(await rub("updateBotEndpoints", { url: hook, type }))); }
        catch (e) { lines.push(type + " ERROR: " + e.message); }
      }
      try { lines.push("getMe: " + JSON.stringify(await rub("getMe", {}))); } catch (e) { lines.push("getMe ERROR: " + e.message); }
      return txt(lines.join("\n\n"));
    }
    if (u.pathname === "/debug") {
      if (u.searchParams.get("t") !== TOKEN.slice(-8)) return txt("no", 403);
      return txt((await env.STATE.get("dbg")) || "چیزی ثبت نشده.");
    }
    return txt("ربات روشنه ✅");
  },
};
