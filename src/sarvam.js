'use strict';

const axios = require('axios');
const FormData = require('form-data');

const BASE = 'https://api.sarvam.ai';
const KEY  = process.env.SARVAM_API_KEY;

const HEADERS = { 'api-subscription-key': KEY };

// ─── Voice Map for Bulbul TTS ─────────────────────────────────────────────────

const VOICE_MAP = {
  'hi-IN': 'anushka',
  'ta-IN': 'pavithra',
  'te-IN': 'arvind',
  'bn-IN': 'amartya',
  'kn-IN': 'suresh',
  'mr-IN': 'anushka',
  'gu-IN': 'manisha',
  'pa-IN': 'manisha',
  'ml-IN': 'pavithra',
  'od-IN': 'anushka',
  'en-IN': 'anushka',
};

// ─── Language name → BCP47 map ────────────────────────────────────────────────

const LANG_MAP = {
  hindi:      'hi-IN', हिंदी: 'hi-IN',
  tamil:      'ta-IN', தமிழ்: 'ta-IN',
  telugu:     'te-IN', తెలుగు: 'te-IN',
  bengali:    'bn-IN', বাংলা: 'bn-IN',
  kannada:    'kn-IN', ಕನ್ನಡ: 'kn-IN',
  marathi:    'mr-IN', मराठी: 'mr-IN',
  gujarati:   'gu-IN', ગુજરાતી: 'gu-IN',
  punjabi:    'pa-IN', ਪੰਜਾਬੀ: 'pa-IN',
  malayalam:  'ml-IN', മലയാളം: 'ml-IN',
  odia:       'od-IN', ଓଡ଼ିଆ: 'od-IN',
  english:    'en-IN',
};

function resolveLang(name) {
  if (!name) return null;
  return LANG_MAP[name.toLowerCase()] || LANG_MAP[name] || null;
}

// ─── JSON response parser (handles <think> blocks + markdown fences) ─────────

function parseJsonResponse(raw) {
  try {
    // 1. Strip <think>...</think> reasoning blocks
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // 2. Strip markdown code fences
    clean = clean.replace(/```(?:json)?\n?([\s\S]*?)```/g, '$1').trim();
    // 3. Try direct parse
    try { return JSON.parse(clean); } catch (_) {}
    // 4. Extract first {...} block via regex
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}
  return { intent: 'help', items: [] };
}

// ─── STT — Saaras v3 ─────────────────────────────────────────────────────────

async function transcribeAudio(audioBuffer, mimeType, langCode = 'unknown') {
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename:    'audio.ogg',
    contentType: mimeType || 'audio/ogg',
  });
  form.append('model',         'saaras:v3');
  form.append('language_code', langCode);
  form.append('mode',          'codemix');

  const resp = await axios.post(`${BASE}/speech-to-text`, form, {
    headers: { ...HEADERS, ...form.getHeaders() },
    timeout: 15000,
  });
  return resp.data.transcript || '';
}

// ─── NLU — sarvam-m chat completions ─────────────────────────────────────────

const NLU_PROMPT = `You are a kirana store inventory AI. Extract sale/purchase info from Hindi, Hinglish, or any Indian language message.
Return ONLY a JSON object — no explanation, no markdown fences.

Required keys:
- intent: "sale" | "purchase" | "stock_check" | "udhar_check" | "ledger" | "help" | "set_language" | "payment_confirm"
- items: array of {name, qty (number or null), unit (kg/piece/litre/packet/dozen/box or null)}
- customer_name: string or null
- payment_mode: "cash" | "upi" | "udhar" | null
- language: language name string or null (only when user sets language)

Intent rules:
- Sale keywords: diya, gaya, becha, sold, nikala → "sale"
- Purchase keywords: aaya, liya, mila, invoice, bill, kharida → "purchase"
- "ledger", "stock", "hisaab", "inventory", "sab dikhao", "dikha" → "ledger"
- Single word "udhar"/"khata"/"credit"/"baaki" → "udhar_check"
- Single word "cash"/"nakit"/"paise" → "payment_confirm" with payment_mode "cash"
- Single word "upi"/"paytm"/"gpay"/"phonepay" → "payment_confirm" with payment_mode "upi"
- "language X" / "bhasha X" → "set_language" with language field set
- Sale containing "udhar" → payment_mode "udhar"
- Sale containing "cash" → payment_mode "cash"

Number words: ek=1 do=2 teen=3 char=4 paanch=5 chhe=6 saat=7 aath=8 nau=9 das=10 bees=20 pachas=50 sau=100`;

async function extractEntities(text) {
  const resp = await axios.post(`${BASE}/v1/chat/completions`, {
    model:       'sarvam-m',
    messages: [
      { role: 'system', content: NLU_PROMPT },
      { role: 'user',   content: text },
    ],
    temperature: 0.0,
    max_tokens:  1000,
  }, { headers: { ...HEADERS, 'Content-Type': 'application/json' }, timeout: 25000 });

  const raw = resp.data.choices?.[0]?.message?.content || '{}';
  return parseJsonResponse(raw);
}

// ─── Vision — Invoice OCR ─────────────────────────────────────────────────────

const INVOICE_PROMPT = `You are an expert at reading Indian supplier invoices for kirana stores.
Extract ALL line items from this invoice image.
Return ONLY valid JSON — no markdown.

Schema:
{
  "supplier_name": "string or null",
  "invoice_number": "string or null",
  "items": [
    {"name": "item name as on invoice", "qty": number, "unit": "kg/piece/packet/box/litre/dozen", "rate": number_or_null}
  ],
  "total": number_or_null
}

If the image is not an invoice or is unreadable, return: {"items": [], "error": "not_invoice"}`;

const PRODUCT_PROMPT = `Identify this FMCG / grocery product from the photo.
Return ONLY valid JSON — no markdown.

Schema:
{
  "brand": "brand name or null",
  "name": "product name",
  "size": "size or weight like 70g, 1L, 5kg — or null",
  "confidence": 0.0_to_1.0
}

If the image is not a product, return: {"name": null, "confidence": 0}`;

async function analyzeImage(imageBuffer, mimeType, promptText) {
  const b64 = imageBuffer.toString('base64');
  const resp = await axios.post(`${BASE}/v1/chat/completions`, {
    model:    'sarvam-m',
    messages: [{
      role:    'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
        { type: 'text',      text: promptText },
      ],
    }],
    temperature: 0.0,
    max_tokens:  1200,
  }, { headers: { ...HEADERS, 'Content-Type': 'application/json' }, timeout: 30000 });

  const raw = resp.data.choices?.[0]?.message?.content || '{}';
  const result = parseJsonResponse(raw);
  return result.items !== undefined ? result : { items: [], error: 'parse_error' };
}

// ─── Translation — Sarvam Mayura ─────────────────────────────────────────────

async function translate(hindiText, targetLang) {
  if (!targetLang || targetLang === 'hi-IN') return hindiText;

  try {
    const resp = await axios.post(`${BASE}/translate`, {
      input:                hindiText,
      source_language_code: 'hi-IN',
      target_language_code: targetLang,
      model:                'mayura:v1',
      mode:                 'formal',
      numerals_format:      'international',
    }, { headers: { ...HEADERS, 'Content-Type': 'application/json' }, timeout: 10000 });

    return resp.data.translated_text || hindiText;
  } catch (err) {
    console.error('[translate] error:', err.message);
    return hindiText; // fall back to Hindi
  }
}

module.exports = {
  transcribeAudio,
  extractEntities,
  analyzeImage,
  translate,
  resolveLang,
  INVOICE_PROMPT,
  PRODUCT_PROMPT,
};
