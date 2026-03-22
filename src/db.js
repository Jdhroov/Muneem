'use strict';

const { Database } = require('node-sqlite3-wasm');
const path = require('path');

const db = new Database(path.join(__dirname, '../muneem.db'));

// WAL mode for safety
db.exec("PRAGMA journal_mode = WAL");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    phone       TEXT PRIMARY KEY,
    language    TEXT    DEFAULT 'hi-IN',
    state       TEXT    DEFAULT 'idle',
    pending     TEXT,
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS catalog_item (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    name_hi        TEXT,
    brand          TEXT,
    category       TEXT    DEFAULT 'OTHER',
    unit           TEXT    DEFAULT 'piece',
    current_stock  REAL    DEFAULT 0,
    reorder_point  REAL    DEFAULT 5,
    mrp            REAL,
    purchase_price REAL,
    gst_rate       REAL    DEFAULT 0,
    updated_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    name, name_hi, brand,
    content=catalog_item,
    content_rowid=id
  );

  CREATE TABLE IF NOT EXISTS stock_inward (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT,
    supplier_name TEXT,
    invoice_no    TEXT,
    items_json    TEXT,
    total_value   REAL    DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sale_transaction (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT,
    source        TEXT,
    items_json    TEXT,
    customer_name TEXT,
    payment_mode  TEXT    DEFAULT 'unknown',
    total_amount  REAL    DEFAULT 0,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS udhar_entry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT,
    customer_name TEXT    NOT NULL,
    amount        REAL,
    cleared       INTEGER DEFAULT 0,
    sale_id       INTEGER REFERENCES sale_transaction(id),
    created_at    TEXT    DEFAULT (datetime('now'))
  );
`);

// ─── Seed Catalog ─────────────────────────────────────────────────────────────

const { c: itemCount } = db.get('SELECT COUNT(*) AS c FROM catalog_item');
if (itemCount === 0) seedCatalog();

function seedCatalog() {
  const ITEMS = [
    // Instant Noodles
    ['Maggi Masala Noodles 70g',       'मैगी मसाला नूडल्स',      'Nestle',      'FMCG_BRANDED', 'piece',  14,   18],
    ['Maggi Atta Noodles 80g',         'मैगी आटा नूडल्स',        'Nestle',      'FMCG_BRANDED', 'piece',  15,   18],
    ['Yippee Noodles Magic Masala 70g','यिप्पी नूडल्स',          'Sunfeast',    'FMCG_BRANDED', 'piece',  14,   18],
    // Biscuits
    ['Parle-G Biscuits 100g',          'पारले-जी बिस्किट',       'Parle',       'FMCG_BRANDED', 'piece',  10,   18],
    ['Parle-G Biscuits 800g',          'पारले-जी बड़ा',           'Parle',       'FMCG_BRANDED', 'piece',  80,   18],
    ['Britannia Good Day 75g',         'ब्रिटानिया गुड डे',       'Britannia',   'FMCG_BRANDED', 'piece',  20,   18],
    ['Sunfeast Marie Light 200g',      'सनफीस्ट मैरी',           'Sunfeast',    'FMCG_BRANDED', 'piece',  25,   18],
    ['Hide and Seek 100g',             'हाइड एंड सीक',           'Parle',       'FMCG_BRANDED', 'piece',  30,   18],
    // Atta / Flour
    ['Aashirvaad Atta 5kg',            'आशीर्वाद आटा 5kg',       'ITC',         'FMCG_STAPLE',  'piece', 240,    0],
    ['Aashirvaad Atta 10kg',           'आशीर्वाद आटा 10kg',      'ITC',         'FMCG_STAPLE',  'piece', 470,    0],
    ['Chakki Fresh Atta 5kg',          'चक्की फ्रेश आटा',        'Pillsbury',   'FMCG_STAPLE',  'piece', 230,    0],
    ['Aata',                           'आटा',                    null,          'LOOSE',        'kg',   null,    0],
    // Rice
    ['India Gate Basmati 5kg',         'इंडिया गेट बासमती',      'KRBL',        'FMCG_STAPLE',  'piece', 450,    5],
    ['Daawat Basmati 5kg',             'दावत बासमती',            'Daawat',      'FMCG_STAPLE',  'piece', 420,    5],
    ['Chawal',                         'चावल',                   null,          'LOOSE',        'kg',   null,    5],
    // Dal / Pulses
    ['Toor Dal',                       'तुअर दाल',               null,          'LOOSE',        'kg',   null,    0],
    ['Moong Dal',                      'मूंग दाल',               null,          'LOOSE',        'kg',   null,    0],
    ['Chana Dal',                      'चना दाल',                null,          'LOOSE',        'kg',   null,    0],
    ['Masoor Dal',                     'मसूर दाल',               null,          'LOOSE',        'kg',   null,    0],
    ['Urad Dal',                       'उड़द दाल',               null,          'LOOSE',        'kg',   null,    0],
    // Sugar / Salt
    ['Cheeni',                         'चीनी',                   null,          'LOOSE',        'kg',   null,    0],
    ['Namak',                          'नमक',                    null,          'LOOSE',        'kg',   null,    0],
    ['Tata Salt 1kg',                  'टाटा नमक',               'Tata',        'FMCG_BRANDED', 'piece',  22,    0],
    // Oil
    ['Fortune Sunflower Oil 1L',       'फॉर्च्यून तेल 1L',       'Fortune',     'FMCG_BRANDED', 'piece', 135,    5],
    ['Fortune Refined Oil 5L',         'फॉर्च्यून तेल 5L',       'Fortune',     'FMCG_BRANDED', 'piece', 650,    5],
    ['Saffola Gold 1L',                'सफोला गोल्ड',            'Marico',      'FMCG_BRANDED', 'piece', 155,    5],
    ['Tel',                            'तेल',                    null,          'LOOSE',        'litre',null,    5],
    // Ghee
    ['Amul Ghee 1L',                   'अमूल घी',                'Amul',        'FMCG_BRANDED', 'piece', 580,   12],
    ['Ghee',                           'घी',                     null,          'LOOSE',        'kg',   null,   12],
    // Spices
    ['MDH Garam Masala 100g',          'एमडीएच गरम मसाला',       'MDH',         'FMCG_BRANDED', 'piece',  65,    5],
    ['MDH Chaat Masala 100g',          'एमडीएच चाट मसाला',       'MDH',         'FMCG_BRANDED', 'piece',  45,    5],
    ['Everest Pav Bhaji Masala 100g',  'एवरेस्ट पाव भाजी',       'Everest',     'FMCG_BRANDED', 'piece',  55,    5],
    ['Lal Mirch',                      'लाल मिर्च',              null,          'LOOSE',        'kg',   null,    5],
    ['Haldi',                          'हल्दी',                  null,          'LOOSE',        'kg',   null,    5],
    ['Jeera',                          'जीरा',                   null,          'LOOSE',        'kg',   null,    5],
    ['Dhaniya',                        'धनिया',                  null,          'LOOSE',        'kg',   null,    5],
    // Toothpaste
    ['Colgate MaxFresh 200g',          'कोलगेट मैक्स फ्रेश',     'Colgate',     'FMCG_BRANDED', 'piece',  95,   18],
    ['Colgate Strong Teeth 200g',      'कोलगेट स्ट्रॉन्ग टीथ',  'Colgate',     'FMCG_BRANDED', 'piece',  85,   18],
    ['Pepsodent 200g',                 'पेप्सोडेंट',             'HUL',         'FMCG_BRANDED', 'piece',  75,   18],
    ['Dabur Red Toothpaste 200g',      'डाबर रेड',               'Dabur',       'FMCG_BRANDED', 'piece',  85,   18],
    // Soap
    ['Lux Soap 100g',                  'लक्स साबुन',             'HUL',         'FMCG_BRANDED', 'piece',  30,   18],
    ['Lifebuoy Soap 100g',             'लाइफबॉय साबुन',          'HUL',         'FMCG_BRANDED', 'piece',  25,   18],
    ['Dettol Soap 125g',               'डेटॉल साबुन',            'Reckitt',     'FMCG_BRANDED', 'piece',  45,   18],
    ['Dove Beauty Bar 75g',            'डव सोप',                 'HUL',         'FMCG_BRANDED', 'piece',  55,   18],
    // Shampoo
    ['Head and Shoulders 180ml',       'हेड एंड शोल्डर्स',       'P&G',         'FMCG_BRANDED', 'piece', 175,   18],
    ['Clinic Plus 340ml',              'क्लिनिक प्लस',           'HUL',         'FMCG_BRANDED', 'piece', 155,   18],
    ['Pantene 340ml',                  'पैंटीन',                 'P&G',         'FMCG_BRANDED', 'piece', 185,   18],
    // Tea / Coffee
    ['Tata Tea Premium 500g',          'टाटा टी प्रीमियम',       'Tata',        'FMCG_BRANDED', 'piece', 220,   18],
    ['Red Label Tea 500g',             'रेड लेबल चाय',           'HUL',         'FMCG_BRANDED', 'piece', 215,   18],
    ['Bru Coffee 200g',                'ब्रू कॉफी',              'HUL',         'FMCG_BRANDED', 'piece', 195,   18],
    ['Nescafe Classic 200g',           'नेस्कैफे क्लासिक',       'Nestle',      'FMCG_BRANDED', 'piece', 380,   18],
    ['Chai Patti',                     'चाय पत्ती',              null,          'LOOSE',        'kg',   null,   18],
    // Chips & Snacks
    ['Lays Classic 26g',               'लेज़ चिप्स',             'PepsiCo',     'FMCG_BRANDED', 'piece',  20,   12],
    ['Kurkure Masala Munch 40g',       'कुरकुरे',                'PepsiCo',     'FMCG_BRANDED', 'piece',  20,   12],
    ['Haldirams Bhujia 200g',          'हल्दीराम भुजिया',        'Haldirams',   'FMCG_BRANDED', 'piece',  75,   12],
    ['Haldirams Aloo Bhujia 400g',     'हल्दीराम आलू भुजिया',   'Haldirams',   'FMCG_BRANDED', 'piece', 130,   12],
    // Dairy
    ['Amul Butter 100g',               'अमूल बटर',               'Amul',        'DAIRY',        'piece',  60,   12],
    ['Amul Cheese Slices 200g',        'अमूल चीज़',              'Amul',        'DAIRY',        'piece', 120,   12],
    ['Mother Dairy Milk 500ml',        'मदर डेयरी दूध',          'Mother Dairy','DAIRY',        'piece',  28,    5],
    ['Amul Milk 500ml',                'अमूल दूध',               'Amul',        'DAIRY',        'piece',  27,    5],
    ['Dudh',                           'दूध',                    null,          'LOOSE',        'litre',null,    5],
    // Cold Drinks
    ['Coca Cola 600ml',                'कोका कोला',              'Coca Cola',   'FMCG_BRANDED', 'piece',  40,   28],
    ['Pepsi 600ml',                    'पेप्सी',                 'PepsiCo',     'FMCG_BRANDED', 'piece',  40,   28],
    ['Thums Up 600ml',                 'थम्स अप',                'Coca Cola',   'FMCG_BRANDED', 'piece',  40,   28],
    ['Sprite 600ml',                   'स्प्राइट',               'Coca Cola',   'FMCG_BRANDED', 'piece',  40,   28],
    ['Frooti 200ml',                   'फ्रूटी',                 'Parle Agro',  'FMCG_BRANDED', 'piece',  15,   12],
    ['Maaza 600ml',                    'माज़ा',                  'Coca Cola',   'FMCG_BRANDED', 'piece',  45,   28],
    ['Bisleri Water 1L',               'बिसलेरी पानी',           'Bisleri',     'FMCG_BRANDED', 'piece',  20,   12],
    // Household
    ['Vim Dishwash Bar 200g',          'विम बार',                'HUL',         'FMCG_BRANDED', 'piece',  30,   18],
    ['Harpic 500ml',                   'हार्पिक',                'Reckitt',     'FMCG_BRANDED', 'piece', 115,   18],
    ['Surf Excel 500g',                'सर्फ एक्सेल',            'HUL',         'FMCG_BRANDED', 'piece',  90,   18],
    ['Ariel 500g',                     'एरियल',                  'P&G',         'FMCG_BRANDED', 'piece', 100,   18],
    ['Rin Bar 250g',                   'रिन बार',                'HUL',         'FMCG_BRANDED', 'piece',  20,   18],
    ['Dettol Handwash 200ml',          'डेटॉल हैंडवॉश',          'Reckitt',     'FMCG_BRANDED', 'piece',  85,   18],
    // Health / Misc
    ['Dettol Antiseptic 100ml',        'डेटॉल एंटीसेप्टिक',      'Reckitt',     'FMCG_BRANDED', 'piece',  70,   12],
    ['Vicks VapoRub 50g',              'विक्स',                  'P&G',         'FMCG_BRANDED', 'piece',  90,   12],
    ['Zandu Balm 8ml',                 'ज़ंडू बाम',              'Zandu',       'FMCG_BRANDED', 'piece',  35,   12],
    ['Amul Gold Milk 500ml',           'अमूल गोल्ड दूध',         'Amul',        'DAIRY',        'piece',  32,    5],
    ['Maggi Tomato Ketchup 1kg',       'मैगी केचप',              'Nestle',      'FMCG_BRANDED', 'piece', 175,   12],
    ['Kissan Jam 500g',                'किसान जैम',              'HUL',         'FMCG_BRANDED', 'piece', 115,   12],
    ['Matchbox',                       'माचिस',                  null,          'FMCG_BRANDED', 'piece',   2,   12],
    ['Anda',                           'अंडा',                   null,          'LOOSE',        'piece',null,    0],
  ];

  db.exec('BEGIN');
  for (const [name, name_hi, brand, category, unit, mrp, gst_rate] of ITEMS) {
    db.run(
      `INSERT INTO catalog_item (name, name_hi, brand, category, unit, mrp, gst_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, name_hi, brand, category, unit, mrp, gst_rate]
    );
  }
  db.exec('COMMIT');
  db.exec(`INSERT INTO catalog_fts(catalog_fts) VALUES('rebuild')`);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function getSession(phone) {
  let s = db.get('SELECT * FROM sessions WHERE phone = ?', [phone]);
  if (!s) {
    // New user — start in onboarding state
    db.run("INSERT INTO sessions (phone, state) VALUES (?, 'new')", [phone]);
    s = db.get('SELECT * FROM sessions WHERE phone = ?', [phone]);
  }
  return s;
}

function setSession(phone, fields) {
  const keys = Object.keys(fields);
  const sql  = keys.map(k => `${k} = ?`).join(', ');
  db.run(
    `UPDATE sessions SET ${sql}, updated_at = datetime('now') WHERE phone = ?`,
    [...keys.map(k => fields[k]), phone]
  );
}

// ─── Catalog helpers ──────────────────────────────────────────────────────────

function searchCatalog(term) {
  if (!term || !term.trim()) return [];
  const clean = term.trim().replace(/['"*]/g, '');

  // FTS5 first
  try {
    const rows = db.all(
      `SELECT ci.* FROM catalog_fts
       JOIN catalog_item ci ON ci.id = catalog_fts.rowid
       WHERE catalog_fts MATCH ?
       LIMIT 5`,
      [clean + '*']
    );
    if (rows.length > 0) return rows;
  } catch (_) {}

  // LIKE fallback
  return db.all(
    `SELECT * FROM catalog_item
     WHERE name LIKE ? OR name_hi LIKE ? OR brand LIKE ?
     LIMIT 5`,
    [`%${clean}%`, `%${clean}%`, `%${clean}%`]
  );
}

function findOrCreateItem(name, unit = 'piece') {
  const matches = searchCatalog(name);
  if (matches.length > 0) return matches[0];
  const r = db.run(
    `INSERT INTO catalog_item (name, category, unit, current_stock) VALUES (?, 'LOOSE', ?, 0)`,
    [name, unit]
  );
  return db.get('SELECT * FROM catalog_item WHERE id = ?', [r.lastInsertRowid]);
}

function getItem(id) {
  return db.get('SELECT * FROM catalog_item WHERE id = ?', [id]);
}

function adjustStock(itemId, delta) {
  db.run(
    `UPDATE catalog_item
     SET current_stock = MAX(0, current_stock + ?), updated_at = datetime('now')
     WHERE id = ?`,
    [delta, itemId]
  );
}

// ─── Transaction helpers ──────────────────────────────────────────────────────

function recordInward(phone, supplierName, invoiceNo, items, totalValue) {
  const r = db.run(
    `INSERT INTO stock_inward (phone, supplier_name, invoice_no, items_json, total_value)
     VALUES (?, ?, ?, ?, ?)`,
    [phone, supplierName, invoiceNo, JSON.stringify(items), totalValue]
  );
  db.exec('BEGIN');
  try {
    for (const item of items) {
      const cat = findOrCreateItem(item.name, item.unit || 'piece');
      adjustStock(cat.id, item.qty);
      item.catalog_id = cat.id;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return r.lastInsertRowid;
}

function recordSale(phone, source, items, customerName, paymentMode, totalAmount) {
  const r = db.run(
    `INSERT INTO sale_transaction (phone, source, items_json, customer_name, payment_mode, total_amount)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [phone, source, JSON.stringify(items), customerName, paymentMode, totalAmount]
  );
  const saleId = r.lastInsertRowid;

  db.exec('BEGIN');
  try {
    for (const item of items) {
      if (item.catalog_id) adjustStock(item.catalog_id, -item.qty);
    }
    if (paymentMode === 'udhar' && customerName) {
      db.run(
        `INSERT INTO udhar_entry (phone, customer_name, amount, sale_id) VALUES (?, ?, ?, ?)`,
        [phone, customerName, totalAmount, saleId]
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return saleId;
}

function getInventory() {
  // Only return items that have been actively used (stock > 0 or ever transacted)
  return db.all(
    `SELECT * FROM catalog_item WHERE current_stock > 0 ORDER BY category, name`
  );
}

function getUdharSummary(phone) {
  return db.all(
    `SELECT customer_name, SUM(amount) AS total, COUNT(*) AS count
     FROM udhar_entry
     WHERE phone = ? AND cleared = 0
     GROUP BY customer_name
     ORDER BY total DESC`,
    [phone]
  );
}

module.exports = {
  getSession, setSession,
  searchCatalog, findOrCreateItem, getItem, adjustStock,
  recordInward, recordSale,
  getInventory, getUdharSummary,
};
