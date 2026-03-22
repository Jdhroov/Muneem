'use strict';

const axios = require('axios');
const db    = require('./db');
const s     = require('./sarvam');

// ─── Language options (shown during onboarding) ───────────────────────────────

const LANGUAGES = [
  { num: '1', name: 'Hindi',     code: 'hi-IN', native: 'हिंदी'      },
  { num: '2', name: 'Tamil',     code: 'ta-IN', native: 'தமிழ்'      },
  { num: '3', name: 'Telugu',    code: 'te-IN', native: 'తెలుగు'     },
  { num: '4', name: 'Bengali',   code: 'bn-IN', native: 'বাংলা'      },
  { num: '5', name: 'Kannada',   code: 'kn-IN', native: 'ಕನ್ನಡ'      },
  { num: '6', name: 'Marathi',   code: 'mr-IN', native: 'मराठी'      },
  { num: '7', name: 'Gujarati',  code: 'gu-IN', native: 'ગુજરાતી'    },
  { num: '8', name: 'Punjabi',   code: 'pa-IN', native: 'ਪੰਜਾਬੀ'     },
  { num: '9', name: 'English',   code: 'en-IN', native: 'English'    },
];

function matchLang(input) {
  const t = (input || '').trim().toLowerCase();
  return LANGUAGES.find(l =>
    l.num === t ||
    l.name.toLowerCase() === t ||
    l.native === input.trim() ||
    l.code === t
  ) || null;
}

// ─── Translate helper ─────────────────────────────────────────────────────────

async function t(hindiText, langCode) {
  return s.translate(hindiText, langCode);
}

// ─── Download media from Twilio ───────────────────────────────────────────────

async function downloadMedia(url) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  const config = {
    responseType: 'arraybuffer',
    timeout:      25000,
  };
  // Use Basic Auth if credentials are present
  if (sid && token && !sid.startsWith('YOUR_')) {
    config.auth = { username: sid, password: token };
  }

  const resp = await axios.get(url, config);
  return {
    buffer:   Buffer.from(resp.data),
    mimeType: (resp.headers['content-type'] || 'application/octet-stream').split(';')[0].trim(),
  };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function dispatch(from, body, mediaUrl, mediaContentType) {
  const phone   = from;
  const session = db.getSession(phone);
  const lang    = session.language || 'hi-IN';
  const text    = (body || '').trim();

  // ── Onboarding: brand new user ───────────────────────────────────────────
  if (session.state === 'new') {
    db.setSession(phone, { state: 'onboarding_lang' });
    return buildWelcome();
  }

  // ── Onboarding: waiting for language choice ──────────────────────────────
  if (session.state === 'onboarding_lang') {
    return handleLangChoice(phone, text);
  }

  // ── Onboarding: waiting for first invoice photo ──────────────────────────
  if (session.state === 'onboarding_invoice') {
    if (mediaUrl && (mediaContentType || '').startsWith('image/')) {
      let media;
      try { media = await downloadMedia(mediaUrl); } catch (err) {
        console.error('[onboarding invoice] download error:', err.message);
        return t(`📡 Photo download nahi hua. Dobara bhejein.`, lang);
      }
      return handleOnboardingInvoice(phone, lang, media.buffer, media.mimeType);
    }
    // User typed something instead of photo — allow skipping
    if (/skip|baad mein|later|abhi nahi/i.test(text)) {
      db.setSession(phone, { state: 'idle' });
      return t(
        `Theek hai! Jab bhi invoice photo milein, bhej dena.\n\nAbhi kuch bhi bolo:\n• 📸 Photo bhejo — sale ya invoice\n• 🎙️ Voice note — "ek Maggi gaya"\n• *hisaab* — stock dekho`,
        lang
      );
    }
    return t(`📸 Apne supplier ki invoice ki photo bhejein — main poora stock ek baar mein add kar dunga.\n\nAbhi nahi hai? Type karo *skip*`, lang);
  }

  // ── Normal operation ─────────────────────────────────────────────────────

  // Waiting for payment mode (cash/udhar) after a sale
  if (session.state === 'awaiting_payment_mode') {
    return handlePaymentModeReply(phone, lang, text, session);
  }

  // Media message (image or voice)
  if (mediaUrl) {
    let media;
    try {
      media = await downloadMedia(mediaUrl);
    } catch (err) {
      console.error('[media] download error:', err.message);
      if (err.response?.status === 401 || err.response?.status === 403) {
        return t(
          `📡 Photo download ke liye TWILIO_ACCOUNT_SID aur AUTH_TOKEN .env mein add karein, phir server restart karein.`,
          lang
        );
      }
      return t(`📡 File load nahi hua. Dobara bhejein.`, lang);
    }

    const mt = mediaContentType || media.mimeType;

    // Voice note
    if (mt.startsWith('audio/')) {
      return handleVoiceNote(phone, lang, media.buffer, mt, text);
    }

    // Image
    if (mt.startsWith('image/')) {
      // Caption hint decides invoice vs product
      const cap = text.toLowerCase();
      const isInvoice = /invoice|bill|delivery|maal aaya|aaya|supplier|kharida|stock add/i.test(cap);
      if (isInvoice) return handleInvoicePhoto(phone, lang, media.buffer, mt);
      return handleProductPhoto(phone, lang, media.buffer, mt, text);
    }

    return t(`📎 Yeh file type support nahi hota. Photo ya voice note bhejein.`, lang);
  }

  // Text message
  if (text) return handleText(phone, lang, text);

  return t(`👋 Kuch bolo! "hisaab" likhein stock dekhne ke liye.`, lang);
}

// ─── Onboarding: welcome message ─────────────────────────────────────────────

function buildWelcome() {
  const lines = [
    `🏪 *Namaste! Main MUNEEM hoon.*`,
    `Aapka personal dukan ka hisaab rakhne wala AI — bina kisi form ke.`,
    ``,
    `Pehle apni bhasha chunein:`,
    ``,
    ...LANGUAGES.map(l => `${l.num}️⃣ ${l.native}  (${l.name})`),
    ``,
    `Sirf number bhejein — jaise *1* for Hindi`,
  ];
  return lines.join('\n');
}

// ─── Onboarding: language selection ──────────────────────────────────────────

async function handleLangChoice(phone, text) {
  const match = matchLang(text);
  if (!match) {
    const opts = LANGUAGES.map(l => `${l.num} - ${l.native}`).join('\n');
    return `Samajh nahi aaya. Sirf number bhejein:\n\n${opts}`;
  }

  db.setSession(phone, { language: match.code, state: 'onboarding_invoice' });

  return t(
    `✅ Bhasha set ho gayi — *${match.name}*!\n\nAb apne supplier ki *invoice ki photo* bhejein.\n\nMain ek baar mein poora stock entry kar dunga. 📦`,
    match.code
  );
}

// ─── Onboarding: first invoice photo → build initial inventory ────────────────

async function handleOnboardingInvoice(phone, lang, imageBuffer, mimeType) {
  let parsed;
  try {
    parsed = await s.analyzeImage(imageBuffer, mimeType, s.INVOICE_PROMPT);
  } catch (err) {
    console.error('[onboarding invoice] error:', err.message);
  }

  if (!parsed || parsed.error || !parsed.items || parsed.items.length === 0) {
    return t(
      `📸 Invoice saaf nahi dikh raha.\n\nKripya dobara bhejein — poora bill frame mein hona chahiye.\n\nAbhi nahi hai? Type karo *skip*`,
      lang
    );
  }

  // Add all items to inventory
  const items        = parsed.items;
  const supplierName = parsed.supplier_name || 'Supplier';
  const total        = parsed.total || 0;

  db.recordInward(phone, supplierName, parsed.invoice_number || null, items, total);
  db.setSession(phone, { state: 'idle' });

  const itemLines = items.slice(0, 10).map(i => `  • ${i.name}: ${i.qty} ${i.unit || 'piece'}`).join('\n');
  const more      = items.length > 10 ? `\n  ...aur ${items.length - 10} items` : '';

  return t(
    `✅ *Stock ready hai!*\n\n${itemLines}${more}\n\n📦 Total ${items.length} items inventory mein add hue.\n\n*Ab aap use kar sakte ho:*\n• 📸 Koi bhi item ki photo → stock minus hoga\n• 🎙️ Voice note → "ek Maggi gaya"\n• *hisaab* → stock dekho`,
    lang
  );
}

// ─── Layer 1: Invoice photo → Stock Inward ───────────────────────────────────

async function handleInvoicePhoto(phone, lang, imageBuffer, mimeType) {
  let parsed;
  try {
    parsed = await s.analyzeImage(imageBuffer, mimeType, s.INVOICE_PROMPT);
  } catch (err) {
    console.error('[invoice] error:', err.message);
    return t(`📸 Invoice padh nahi paya. Dobara bhejein — poori photo honi chahiye.`, lang);
  }

  if (!parsed || parsed.error || !parsed.items || parsed.items.length === 0) {
    return t(
      `📸 Invoice mein koi item nahi mila.\n\nSaaf photo bhejein — ya caption mein *invoice* likhein agar yeh delivery ka bill hai.`,
      lang
    );
  }

  const items = parsed.items;
  db.recordInward(phone, parsed.supplier_name || 'Supplier', parsed.invoice_number || null, items, parsed.total || 0);

  const lines = items.slice(0, 8).map(i => `  • ${i.name}: *${i.qty}* ${i.unit || 'piece'}`).join('\n');
  const more  = items.length > 8 ? `\n  ...aur ${items.length - 8} items` : '';

  return t(
    `✅ *Maal aa gaya!*\n${parsed.supplier_name ? `🏪 ${parsed.supplier_name}\n` : ''}` +
    `\n${lines}${more}\n\n📦 Stock update ho gaya!`,
    lang
  );
}

// ─── Layer 2: Product photo → Stock Outward (-1) ─────────────────────────────

async function handleProductPhoto(phone, lang, imageBuffer, mimeType, caption) {
  // Check if caption has a quantity (e.g. "3 maggi" or "do packet")
  let captionQty = null;
  if (caption && caption.trim()) {
    const numMatch = caption.match(/^(\d+(?:\.\d+)?)/);
    if (numMatch) captionQty = parseFloat(numMatch[1]);
  }

  let parsed;
  try {
    parsed = await s.analyzeImage(imageBuffer, mimeType, s.PRODUCT_PROMPT);
  } catch (err) {
    console.error('[product] error:', err.message);
    return t(`📸 Product pehchaan nahi paya. Item ka naam type karein.`, lang);
  }

  if (!parsed || !parsed.name || (parsed.confidence || 0) < 0.35) {
    return t(
      `📸 Product pehchaan nahi aaya.\n\nNaam type karein jaise: *"2 Maggi gaya"*`,
      lang
    );
  }

  const productLabel = [parsed.brand, parsed.name, parsed.size].filter(Boolean).join(' ');
  const qty          = captionQty || 1;
  const matches      = db.searchCatalog(parsed.name) || db.searchCatalog(productLabel);
  const catItem      = matches[0] || db.findOrCreateItem(productLabel, 'piece');

  // Immediately decrement stock
  db.adjustStock(catItem.id, -qty);
  const updated  = db.getItem(catItem.id);
  const remaining = updated?.current_stock ?? 0;
  const mrpTotal = catItem.mrp ? `\n💰 ₹${(catItem.mrp * qty).toFixed(0)}` : '';
  const stockAlert = remaining <= (catItem.reorder_point || 5) && remaining > 0 ? '\n⚠️ Stock kam ho raha hai!' : '';
  const outAlert   = remaining === 0 ? '\n🔴 Stock khatam!' : '';

  // Ask payment mode for udhar tracking
  const pending = { type: 'product_sale', product_name: productLabel, catalog_id: catItem.id, mrp: catItem.mrp, qty };
  db.setSession(phone, { state: 'awaiting_payment_mode', pending: JSON.stringify(pending) });

  return t(
    `🛒 *${productLabel}* × ${qty}${mrpTotal}\n📦 ${remaining} baaki${stockAlert}${outAlert}\n\n*Cash mila ya udhar diya?*\nType: cash / upi / udhar`,
    lang
  );
}

// ─── Layer 3: Voice note → Stock Outward ─────────────────────────────────────

async function handleVoiceNote(phone, lang, audioBuffer, mimeType, caption) {
  let transcript = '';
  try {
    transcript = await s.transcribeAudio(audioBuffer, mimeType, lang);
    console.log(`[voice] transcript: "${transcript}"`);
  } catch (err) {
    console.error('[voice] STT error:', err.message);
    return t(
      `🎙️ Awaaz samajh nahi aayi.\nType karo jaise: *"Radha ko ek kilo aata diya"*`,
      lang
    );
  }

  if (!transcript || transcript.trim().length < 2) {
    return t(`🎙️ Awaaz clear nahi thi. Dobara bolein ya type karein.`, lang);
  }

  return handleText(phone, lang, transcript, 'voice');
}

// ─── Text message handler ─────────────────────────────────────────────────────

async function handleText(phone, lang, text, source = 'text') {
  const session = db.getSession(phone);

  // Pending payment mode reply
  if (session.state === 'awaiting_payment_mode') {
    return handlePaymentModeReply(phone, lang, text, session);
  }

  const lower = text.toLowerCase().trim();

  // ── Quick commands ────────────────────────────────────────────────────────
  if (/^(hisaab|ledger|stock|inventory|sab dikhao|dikha|status)$/i.test(lower)) {
    return buildLedger(phone, lang);
  }
  if (/^(udhar|khata|credit|baaki|udhaar)$/i.test(lower)) {
    return buildUdharSummary(phone, lang);
  }
  if (/^(help|madad|\?|menu|commands)$/i.test(lower)) {
    return buildHelp(lang);
  }
  // Invoice trigger via text only
  if (/^maal aaya$/i.test(lower)) {
    return t(`📸 Invoice ki photo bhejein — supplier ka bill capture karo.`, lang);
  }

  // ── Language change ───────────────────────────────────────────────────────
  const langMatch = text.match(/^(?:language|bhasha|basha)[:\s]+(.+)/i);
  if (langMatch) {
    const newLang = matchLang(langMatch[1].trim());
    if (newLang) {
      db.setSession(phone, { language: newLang.code });
      return t(`✅ Bhasha *${newLang.name}* set ho gayi!`, newLang.code);
    }
    return t(`❓ Bhasha nahi mili. Likhein: *language Hindi*`, lang);
  }

  // ── NLU extraction ────────────────────────────────────────────────────────
  let entities;
  try {
    entities = await s.extractEntities(text);
  } catch (err) {
    console.error('[nlu] error:', err.message);
    return buildHelp(lang);
  }

  const { intent, items, customer_name, payment_mode } = entities;

  if (intent === 'ledger' || intent === 'stock_check') return buildLedger(phone, lang);
  if (intent === 'udhar_check')                         return buildUdharSummary(phone, lang);
  if (intent === 'set_language' && entities.language) {
    const nl = matchLang(entities.language);
    if (nl) { db.setSession(phone, { language: nl.code }); return t(`✅ Bhasha *${nl.name}* set ho gayi!`, nl.code); }
  }
  if (intent === 'payment_confirm') {
    return t(`❓ Kaunse sale ke liye? Pehle bataein kya bika.`, lang);
  }
  if (intent === 'purchase') return processPurchaseText(phone, lang, items);
  if (intent === 'sale')     return processSaleText(phone, lang, items, customer_name, payment_mode, source);

  return buildHelp(lang);
}

// ─── Purchase via text (maal aaya by typing) ─────────────────────────────────

async function processPurchaseText(phone, lang, items) {
  if (!items || items.length === 0) {
    return t(`❓ Kaunsa maal aaya? Likhein: *"50 Maggi aaya"* ya invoice photo bhejein.`, lang);
  }
  const lines = [];
  for (const item of items) {
    const cat = db.findOrCreateItem(item.name, item.unit || 'piece');
    const qty = item.qty || 1;
    db.adjustStock(cat.id, qty);
    const updated = db.getItem(cat.id);
    lines.push(`  • *${cat.name}*: +${qty} → ${updated.current_stock} ${cat.unit} total`);
  }
  return t(`✅ *Maal aa gaya!*\n\n${lines.join('\n')}\n\n📦 Stock update ho gaya.`, lang);
}

// ─── Sale via text/voice ──────────────────────────────────────────────────────

async function processSaleText(phone, lang, items, customerName, paymentMode, source) {
  if (!items || items.length === 0) {
    return t(`❓ Kaunsa item bika? Likhein: *"3 Maggi gaya cash mein"*`, lang);
  }

  // Resolve items against catalog
  const resolved = [];
  for (const item of items) {
    const matches = db.searchCatalog(item.name);
    const cat     = matches[0] || db.findOrCreateItem(item.name, item.unit || 'piece');
    resolved.push({ name: cat.name, qty: item.qty || 1, unit: item.unit || cat.unit, catalog_id: cat.id, mrp: cat.mrp });
  }

  if (paymentMode) {
    return completeSale(phone, lang, resolved, customerName, paymentMode, source);
  }

  // Ask payment mode
  const pending = { type: 'text_sale', items: resolved, customer_name: customerName, source };
  db.setSession(phone, { state: 'awaiting_payment_mode', pending: JSON.stringify(pending) });

  const summary  = resolved.map(i => `${i.qty} ${i.name}`).join(', ');
  const custPart = customerName ? ` (${customerName} ko)` : '';
  return t(`🛒 *${summary}*${custPart}\n\n*Cash mila ya udhar diya?*\nType: cash / upi / udhar`, lang);
}

// ─── Payment mode resolution ──────────────────────────────────────────────────

async function handlePaymentModeReply(phone, lang, text, session) {
  const lower = text.toLowerCase().trim();
  let paymentMode, extraCustomer;

  if (/^(cash|nakit|paise|nakit|naqd|paid|payment)$/i.test(lower)) {
    paymentMode = 'cash';
  } else if (/^(upi|paytm|gpay|phonepe|google ?pay|bhim|online)$/i.test(lower)) {
    paymentMode = 'upi';
  } else if (/^(udhar|baad mein|credit|udhaar)/i.test(lower)) {
    paymentMode = 'udhar';
    const nameM = text.match(/(?:udhar|udhaar)\s+(.+)/i);
    if (nameM) extraCustomer = nameM[1].trim();
  } else {
    return t(`❓ Samajh nahi aaya.\nType: *cash* ya *upi* ya *udhar*`, lang);
  }

  let pending;
  try { pending = JSON.parse(session.pending || '{}'); } catch { pending = {}; }
  db.setSession(phone, { state: 'idle', pending: null });

  if (pending.type === 'product_sale') {
    const items = [{
      name:       pending.product_name,
      qty:        pending.qty || 1,
      unit:       'piece',
      catalog_id: pending.catalog_id,
      mrp:        pending.mrp,
    }];
    // Stock was already decremented at photo time — just record the transaction
    return recordAndConfirmSale(phone, lang, items, extraCustomer || pending.customer_name || null, paymentMode, 'photo_product', /* alreadyDecremented */ true);
  }

  if (pending.type === 'text_sale') {
    return completeSale(phone, lang, pending.items || [], extraCustomer || pending.customer_name || null, paymentMode, pending.source || 'voice');
  }

  return t(`❌ Session expire ho gaya. Dobara try karein.`, lang);
}

// ─── Complete a sale (decrement + record) ────────────────────────────────────

async function completeSale(phone, lang, items, customerName, paymentMode, source) {
  // Decrement stock
  for (const item of items) {
    if (item.catalog_id) db.adjustStock(item.catalog_id, -item.qty);
  }
  return recordAndConfirmSale(phone, lang, items, customerName, paymentMode, source, false);
}

async function recordAndConfirmSale(phone, lang, items, customerName, paymentMode, source, alreadyDecremented) {
  const totalAmount = items.reduce((s, i) => s + (i.qty * (i.mrp || 0)), 0);
  db.recordSale(phone, source, items, customerName, paymentMode, totalAmount);

  const itemLines  = items.map(i => `• ${i.qty} ${i.name}`).join('\n');
  const payEmoji   = paymentMode === 'cash' ? '💵' : paymentMode === 'upi' ? '📱' : '📒';
  const payLabel   = paymentMode === 'cash' ? 'Cash' : paymentMode === 'upi' ? 'UPI' : 'Udhar';
  const custLine   = customerName ? `\n👤 ${customerName}` : '';
  const totalLine  = totalAmount > 0 ? `\n💰 ₹${totalAmount.toFixed(0)}` : '';

  // Show remaining stock for sold items
  const stockLines = [];
  for (const item of items) {
    if (item.catalog_id) {
      const u = db.getItem(item.catalog_id);
      if (u !== undefined) {
        const warn = u.current_stock <= (u.reorder_point || 5) ? (u.current_stock === 0 ? ' 🔴 Khatam!' : ' ⚠️ Kam hai') : '';
        stockLines.push(`📦 ${item.name}: ${u.current_stock} ${u.unit || 'piece'} baaki${warn}`);
      }
    }
  }

  const hindi = [`✅ *Bik gaya!*`, ``, itemLines, custLine, totalLine, `${payEmoji} ${payLabel}`, ``, ...stockLines]
    .filter(l => l !== undefined).join('\n');

  return t(hindi, lang);
}

// ─── Inventory ledger ─────────────────────────────────────────────────────────

async function buildLedger(phone, lang) {
  const items = db.getInventory();

  if (items.length === 0) {
    return t(
      `📦 Abhi koi stock record nahi hai.\n\n*Shuru karein:*\n• 📸 Invoice photo bhejein (supplier ka bill)\n• Ya type karein: *50 Maggi aaya*`,
      lang
    );
  }

  const catEmoji = { FMCG_BRANDED: '🛒', FMCG_STAPLE: '🌾', LOOSE: '⚖️', DAIRY: '🥛', OTHER: '📦' };
  const groups   = {};
  for (const item of items) {
    const c = item.category || 'OTHER';
    if (!groups[c]) groups[c] = [];
    groups[c].push(item);
  }

  const lines = [`📊 *Muneem — Aaj Ka Stock*\n`];
  for (const [cat, catItems] of Object.entries(groups)) {
    lines.push(`${catEmoji[cat] || '📦'} *${cat.replace('_', ' ')}*`);
    for (const item of catItems) {
      const warn = item.current_stock > 0 && item.current_stock <= (item.reorder_point || 5) ? ' ⚠️' : '';
      const out  = item.current_stock === 0 ? ' 🔴' : '';
      lines.push(`  • ${item.name}: *${item.current_stock} ${item.unit || 'piece'}*${warn}${out}`);
    }
    lines.push('');
  }

  const udhar = db.getUdharSummary(phone);
  if (udhar.length > 0) {
    const total = udhar.reduce((s, u) => s + u.total, 0);
    lines.push(`💳 *Udhar Baaki: ₹${total.toFixed(0)}*`);
    for (const u of udhar.slice(0, 5)) lines.push(`  • ${u.customer_name}: ₹${u.total.toFixed(0)}`);
  }

  return t(lines.join('\n'), lang);
}

// ─── Udhar summary ────────────────────────────────────────────────────────────

async function buildUdharSummary(phone, lang) {
  const rows = db.getUdharSummary(phone);
  if (rows.length === 0) {
    return t(`✅ Koi udhar baaki nahi! Sab hisaab saaf.`, lang);
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  const lines = [`💳 *Udhar Baaki:*\n`, ...rows.map(r => `• *${r.customer_name}*: ₹${r.total.toFixed(0)}`), `\n*Kul: ₹${total.toFixed(0)}*`];
  return t(lines.join('\n'), lang);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

async function buildHelp(lang) {
  const hindi = `🏪 *MUNEEM — Aapka Dukan AI*

Kya bhejna hai:
📸 *Invoice photo* — maal aaya, stock add hoga
📸 *Product photo* — ek item bika, stock minus hoga
🎙️ *Voice note* — "teen Maggi gaya" ya "Radha ko aata diya"
💬 *Text* — "5 Parle-G becha cash mein"

Commands:
• *hisaab* — aaj ka poora stock
• *udhar* — kiska kitna credit baaki hai
• *language Hindi* — bhasha badlo

Koi sawaal? Seedha bolo!`;
  return t(hindi, lang);
}

module.exports = { dispatch };
