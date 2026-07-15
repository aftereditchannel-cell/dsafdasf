'use strict';
/* =========================================================
 * SmartChat — بک‌اند ویجت چت هوشمند (اتصال به Gemini + استخراج اطلاعات سایت)
 * اجرا:  npm start
 * دمو:   http://localhost:3000/demo
 * ========================================================= */

/* بارگذاری .env بدون وابستگی */
const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    });
  }
} catch (_) {}

const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------
 * ذخیره‌سازی سایت‌ها (هر مشتری = یک فایل JSON)
 * --------------------------------------------------------- */
function sitePath(id) {
  return path.join(DATA_DIR, String(id).replace(/[^\w-]/g, '') + '.json');
}
function loadSite(id) {
  const p = sitePath(id);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function saveSite(s) {
  fs.writeFileSync(sitePath(s.id), JSON.stringify(s, null, 2));
}
function listSites() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return { id: s.id, name: s.name, url: s.url, chunks: (s.chunks || []).length, updatedAt: s.updatedAt };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

/* ---------------------------------------------------------
 * ابزار فارسی + بازیابی اطلاعات مرتبط با سؤال
 * --------------------------------------------------------- */
const FA_MAP = { 'ي': 'ی', 'ك': 'ک', 'ة': 'ه', 'ؤ': 'و', 'أ': 'ا', 'إ': 'ا', 'ء': '' };
const STOPWORDS = new Set([
  'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'را', 'با', 'است', 'برای', 'آیا', 'من', 'شما', 'ها',
  'هست', 'می', 'چه', 'چی', 'چطور', 'چجوری', 'سلام', 'لطفا', 'لطفاً', 'دارید', 'داره', 'هستید',
  'ما', 'اون', 'یک', 'یا', 'تا', 'اگر', 'هم', 'شود', 'کنید', 'قیمتش', 'چنده', 'قیمت', 'چقدر', 'بده', 'بگی', 'میخوام', 'میخواهم', 'رو', 'را'
]);

function normalizeFa(t) {
  let s = String(t || '');
  for (const k in FA_MAP) s = s.split(k).join(FA_MAP[k]);
  return s.replace(/\u200c/g, ' ').toLowerCase();
}
function tokenize(t) {
  return normalizeFa(t)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 1 && !STOPWORDS.has(x));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* پیدا کردن مرتبط‌ترین بخش‌های اطلاعات سایت نسبت به سؤال مشتری */
function retrieve(site, query, k) {
  const q = tokenize(query);
  const chunks = site.chunks || [];
  if (!chunks.length) return [];
  if (!q.length) return chunks.slice(0, k);
  const scored = chunks.map((c) => {
    const text = normalizeFa(c.text);
    let score = 0;
    for (const t of new Set(q)) {
      const m = text.match(new RegExp(escapeRe(t), 'g'));
      if (m) score += m.length + 1;
    }
    if (c.type === 'product') score *= 1.4; // اولویت با محصولات
    return { c, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.c);
}

/* ---------------------------------------------------------
 * استخراج اطلاعات از سایت مشتری (خزش + JSON-LD + متن صفحات)
 * --------------------------------------------------------- */
const BLOCKS = 'h1,h2,h3,h4,p,li,article,section';
function norm(t) { return String(t).replace(/\s+/g, ' ').trim(); }

function extractHtml(html, url) {
  const $ = cheerio.load(html);
  const chunks = [];

  // ۱) محصولات با داده ساختاریافته schema.org (فروشگاه‌ها معمولاً دارند)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const flat = [];
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n['@graph']) walk(n['@graph']);
        flat.push(n);
        if (n.itemListElement) walk(n.itemListElement);
      })(data);
      for (const item of flat) {
        const types = [].concat(item['@type'] || []);
        if (types.includes('Product') && item.name) {
          const off = [].concat(item.offers || [])[0] || {};
          chunks.push({
            type: 'product',
            url,
            text: [
              'محصول: ' + item.name,
              off.price ? ('قیمت: ' + off.price + ' ' + (off.priceCurrency || '')).trim() : '',
              item.description ? 'توضیحات: ' + item.description : '',
              off.availability ? 'وضعیت: موجود' : ''
            ].filter(Boolean).join('\n')
          });
        }
      }
    } catch (_) {}
  });

  $('script,style,noscript,iframe,svg').remove();

  // ۲) عنوان و توضیح صفحه
  const title = norm($('title').first().text());
  const desc = $('meta[name="description"]').attr('content') || '';
  if (title || desc) chunks.push({ type: 'meta', url, text: [title, desc].filter(Boolean).join('\n') });

  // ۳) بلوک‌های متنی قابل مشاهده (بدون تکرار: عنصر تو در تو نادیده گرفته می‌شود)
  let buf = '';
  $(BLOCKS).each((_, el) => {
    if ($(el).parents(BLOCKS).length) return;
    const t = norm($(el).text());
    if (t.length < 12 || t.length > 3000) return;
    if ((buf + '\n' + t).length > 700 && buf) {
      chunks.push({ type: 'text', url, text: buf });
      buf = t;
    } else {
      buf = buf ? buf + '\n' + t : t;
    }
  });
  if (buf) chunks.push({ type: 'text', url, text: buf });

  // ۴) لینک‌های داخلی برای خزش صفحات بعدی
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href'), url);
      u.hash = '';
      links.push(u.toString());
    } catch (_) {}
  });

  return { chunks, links };
}

async function scrapeSite(startUrl, maxPages = 8) {
  maxPages = Math.min(maxPages, 25);
  const origin = new URL(startUrl).origin;
  const skip = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|css|js|ico)(\?|#|$)/i;
  const visited = new Set();
  const queue = [startUrl];
  const out = [];

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url) || skip.test(url)) continue;
    visited.add(url);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartChatBot/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html')) continue;
      const { chunks, links } = extractHtml(await res.text(), url);
      out.push(...chunks);
      for (const l of links) {
        if (l.startsWith(origin) && !visited.has(l) && !queue.includes(l)) queue.push(l);
      }
    } catch (_) { /* صفحه معیوب را رد کن */ }
  }

  const seen = new Set();
  const chunks = out.filter((c) => {
    const k = c.text.slice(0, 100);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { pagesVisited: visited.size, chunks };
}

/* ---------------------------------------------------------
 * اتصال به Gemini
 * --------------------------------------------------------- */
async function askGemini(system, messages) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }]
        })),
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 } // پاسخ سریع و کامل برای چت زنده
        }
      }),
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!res.ok) {
    throw new Error('خطای Gemini ' + res.status + ': ' + (await res.text()).slice(0, 300));
  }
  const data = await res.json();
  const txt = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts.map((p) => p.text).join('').trim();
  if (!txt) throw new Error('پاسخی از Gemini دریافت نشد');
  return txt;
}

function buildSystemPrompt(site, context) {
  return [
    `تو «دستیار فروش هوشمند» سایت «${site.name}» هستی و به‌صورت زنده به مشتریان فارسی‌زبان پاسخ می‌دهی.`,
    'قوانین:',
    '- فقط بر اساس «اطلاعات سایت» پایین پاسخ بده؛ درباره چیزی که در اطلاعات نیست حدس نزن و کاربر را به پشتیبانی ارجاع بده.',
    '- پاسخ‌ها کوتاه، صمیمی و دقیق باشند (حداکثر ۵ جمله).',
    '- اگر کاربر به‌دنبال پیشنهاد محصول است، ۱ تا ۳ محصول مرتبط را با قیمت (به تومان) پیشنهاد بده و دلیل کوتاه مناسب‌بودنش را بگو.',
    '- قیمت‌هایی که با واحد IRR ثبت شده‌اند را به تومان اعلام کن.',
    '- اگر سؤال مبهم است (بودجه، سایز یا کاربرد مشخص نیست) یک سؤال کوتاه برای شفاف‌سازی بپرس.',
    '',
    '«اطلاعات سایت»:',
    context || '(هنوز اطلاعاتی ثبت نشده است)'
  ].join('\n');
}

async function answer(site, message, history) {
  const ctx = retrieve(site, message, 6);
  const context = ctx.map((c) => c.text).join('\n---\n').slice(0, 6000);

  /* حالت نمایشی بدون کلید Gemini */
  if (!GEMINI_API_KEY) {
    if (!ctx.length) {
      return 'حالت نمایشی: برای این سایت هنوز اطلاعاتی استخراج نشده است. از API استخراج استفاده کنید یا GEMINI_API_KEY را تنظیم کنید.';
    }
    return '🔍 نزدیک‌ترین اطلاعات سایت به سؤال شما:\n\n' +
      ctx.slice(0, 3).map((c) => '• ' + c.text.slice(0, 300)).join('\n\n') +
      '\n\n(حالت نمایشی — با تنظیم GEMINI_API_KEY پاسخ‌های هوشمند Gemini فعال می‌شود)';
  }

  const system = buildSystemPrompt(site, context);
  const raw = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-10)
    .map((m) => ({ role: m.role, text: String(m.text).slice(0, 2000) }));
  raw.push({ role: 'user', text: message });
  /* Gemini: نقش‌ها باید یکی‌درمیان باشند و اولین پیام از کاربر بیاید */
  const folded = [];
  for (const m of raw) {
    const last = folded[folded.length - 1];
    if (last && last.role === m.role) last.text += '\n' + m.text;
    else folded.push({ role: m.role, text: m.text });
  }
  while (folded.length && folded[0].role !== 'user') folded.shift();
  return askGemini(system, folded.length ? folded : [{ role: 'user', text: message }]);
}

/* ---------------------------------------------------------
 * وب‌سرور و API
 * --------------------------------------------------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));

/* CORS باز — ویجت قرار است روی دامنه سایت مشتری اجرا شود */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function originOf(req) {
  return (req.protocol || 'http') + '://' + req.get('host');
}

/* فایل‌های ویجت و دمو */
app.get('/widget.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'widget.js'));
});
app.get('/', (req, res) => res.redirect('/demo'));
app.get('/demo', (req, res) => {
  res.type('html');
  res.sendFile(path.join(__dirname, 'demo.html'));
});

/* فهرست سایت‌ها */
app.get('/api/sites', (req, res) => res.json(listSites()));

/* ثبت/ویرایش سایت مشتری */
app.post('/api/sites', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '«name» لازم است' });
  const id = String(b.id || crypto.randomBytes(4).toString('hex')).toLowerCase().replace(/[^\w-]/g, '');
  const prev = loadSite(id) || { chunks: [], faqs: [] };
  const site = Object.assign(prev, {
    id,
    name: b.name,
    url: b.url !== undefined ? b.url : (prev.url || ''),
    welcome: b.welcome !== undefined ? b.welcome : (prev.welcome || ('به ' + b.name + ' خوش آمدید')),
    color: b.color !== undefined ? b.color : (prev.color || '#7C3AED'),
    faqs: Array.isArray(b.faqs) ? b.faqs : prev.faqs,
    updatedAt: new Date().toISOString()
  });
  saveSite(site);
  res.json({
    ok: true,
    id,
    embed: '<script src="' + originOf(req) + '/widget.js" data-site="' + id + '"></' + 'script>'
  });
});

/* پیکربندی عمومی ویجت */
app.get('/api/config/:id', (req, res) => {
  const s = loadSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'سایت یافت نشد' });
  res.json({
    name: s.name,
    welcome: s.welcome,
    subtitle: 'پاسخ‌گویی در لحظه با هوش مصنوعی',
    color: s.color,
    faqs: s.faqs || []
  });
});

/* استخراج اطلاعات از سایت مشتری */
app.post('/api/sites/:id/scrape', async (req, res) => {
  const s = loadSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'سایت یافت نشد' });
  const url = (req.body && req.body.url) || s.url;
  if (!url) return res.status(400).json({ error: 'آدرس سایت لازم است (url)' });
  try {
    const { pagesVisited, chunks } = await scrapeSite(url, (req.body && req.body.maxPages) || 8);
    const manual = (s.chunks || []).filter((c) => c.type === 'manual');
    s.chunks = manual.concat(chunks);
    s.url = url;
    s.updatedAt = new Date().toISOString();
    saveSite(s);
    res.json({ ok: true, pagesVisited, chunks: chunks.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* افزودن دستی اطلاعات (کاتالوگ، قوانین و...) */
app.post('/api/sites/:id/knowledge', (req, res) => {
  const s = loadSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'سایت یافت نشد' });
  const texts = (req.body && Array.isArray(req.body.texts)) ? req.body.texts : [];
  s.chunks = (s.chunks || []).concat(
    texts.filter((t) => t && String(t).trim()).map((t) => ({ text: String(t).trim(), url: s.url || '', type: 'manual' }))
  );
  saveSite(s);
  res.json({ ok: true, chunks: (s.chunks || []).length });
});

/* چت */
app.post('/api/chat', async (req, res) => {
  const b = req.body || {};
  if (!b.site || !b.message) return res.status(400).json({ error: '«site» و «message» لازم‌اند' });
  const s = loadSite(b.site);
  if (!s) return res.status(404).json({ error: 'سایت یافت نشد' });
  try {
    const reply = await answer(s, String(b.message).slice(0, 1000), b.history);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(502).json({ error: 'خطا در دریافت پاسخ: ' + (e.message || e) });
  }
});

/* ---------------------------------------------------------
 * فروشگاه نمونه «بوتیک مد روز» برای دمو
 * --------------------------------------------------------- */
if (!loadSite('boutique')) {
  saveSite({
    id: 'boutique',
    name: 'بوتیک مد روز',
    url: 'http://localhost:' + PORT + '/demo',
    welcome: 'به بوتیک مد روز خوش آمدید',
    color: '#7C3AED',
    faqs: [
      'ارسال به شهرستان دارید؟',
      'شرایط مرجوعی کالا چیست؟',
      'راهنمای انتخاب سایز',
      'تخفیف اولین خرید چقدر است؟'
    ],
    chunks: [],
    updatedAt: new Date().toISOString()
  });
}

app.listen(PORT, () => {
  console.log('✅ SmartChat آماده است');
  console.log('   دمو:  http://localhost:' + PORT + '/demo');
  console.log('   حالت Gemini: ' + (GEMINI_API_KEY ? ('فعال (' + GEMINI_MODEL + ')') : 'غیرفعال — فقط حالت نمایشی'));
});
