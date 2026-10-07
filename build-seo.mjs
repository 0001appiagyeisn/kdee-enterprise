#!/usr/bin/env node
/*
 * KD Wisdom Enterprise - SEO page builder
 * ---------------------------------------
 * Your shop loads products with JavaScript, so Google sees very little of them.
 * This script reads your live products from Supabase and writes plain HTML pages Google can read:
 *
 *   /shop/                       list of all categories
 *   /shop/mens-shirts/           one page per category (only categories that have products)
 *   /product/<name>-<id>/        one page per product, with price + stock data for Google
 *   /sitemap.xml                 every address above, so Google finds them all
 *
 * HOW TO RUN (about 1 minute, on your computer, with Node.js installed):
 *   1. Open a terminal INSIDE your website folder (the one containing index.html and the js folder).
 *   2. Put this file in that folder (do not upload it to the website).
 *   3. Run:   node build-seo.mjs
 *   4. Upload the new  shop  and  product  folders and the new  sitemap.xml  to GitHub in ONE commit.
 *   Run it again (and upload) whenever you add or change a batch of products.
 *
 * Optional testing without internet:   node build-seo.mjs --from sample.json
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'https://kdwisdomenterprise.com';
const BRAND = 'KD Wisdom Enterprise';
const CITY = 'Kumasi';
const AREA = 'Kejetia Market, Kumasi, Ghana';
const PHONE_INTL = '+233500111114';
const PHONE_LOCAL = '050 011 1114';
const SIZES = ['L', 'XL', 'XXL', 'XXXL'];

const DEFAULT_CATEGORIES = [
  ['casual', 'Casual'], ['official', 'Official'], ['jeans', 'Jeans'], ['shirts', 'Shirts'], ['tshirts', 'T-Shirts'],
  ['shorts', 'Shorts'], ['trousers', 'Trousers'], ['sweatpants', 'Sweatpants'], ['jackets', 'Jackets'], ['accessories', 'Accessories']
].map(([key, label], i) => ({ key, label, sort_order: i + 1 }));

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
const money = (n) => Number(n || 0).toFixed(2);
const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const normCat = (c) => (c === 'short_jeans' ? 'shorts' : (c || ''));
const imagesOf = (p) => (Array.isArray(p.images) && p.images.length ? p.images : (p.image_url ? [p.image_url] : [])).filter(Boolean);
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); };

// ---------- load data ----------
async function load() {
  const i = process.argv.indexOf('--from');
  if (i > -1) return JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));

  const cfg = fs.readFileSync('js/supabase-config.js', 'utf8');
  const url = (cfg.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  const key = (cfg.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  if (!url || !key) throw new Error('Could not read js/supabase-config.js. Run this script from your website folder.');

  const get = async (table, query) => {
    const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  const products = await get('products', 'select=*&order=created_at.desc&limit=1000');
  let categories = [];
  try { categories = await get('categories', 'select=*&order=sort_order.asc'); } catch (e) { /* use the built-in list */ }
  return { products, categories };
}

// ---------- shared page pieces ----------
function head({ title, description, canonical, image, type = 'website', extra = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(trunc(description, 158))}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="${BRAND}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(trunc(description, 158))}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(image || SITE + '/icons/icon-512.png')}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#121212">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/css/kd-pages.css">
  <style>
    .crumbs { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 14px; }
    .crumbs a { color: var(--accent-hover); }
    .seo-intro { max-width: 820px; color: #444; margin: 6px 0 26px; line-height: 1.7; }
    .seo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px; }
    .seo-card { background: #fff; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; transition: var(--transition); }
    .seo-card:hover { box-shadow: 0 10px 30px rgba(0,0,0,0.12); transform: translateY(-3px); }
    .seo-card img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; background: #f0f0f0; }
    .seo-card .body { padding: 14px; }
    .seo-card h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 6px; }
    .seo-card .price { color: var(--accent-hover); font-weight: 700; }
    .seo-card .sold { color: #a12d27; font-size: 0.78rem; font-weight: 600; }
    .chips-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 26px 0; }
    .chips-row a { background: #fff; border: 1px solid var(--border-color); border-radius: 20px; padding: 7px 16px; font-size: 0.8rem; font-weight: 600; }
    .chips-row a:hover { border-color: var(--accent); color: var(--accent-hover); }
    .prod { display: grid; grid-template-columns: 1fr 1fr; gap: 34px; align-items: start; }
    @media (max-width: 800px) { .prod { grid-template-columns: 1fr; } }
    .prod .main-img { width: 100%; border-radius: 6px; background: #f0f0f0; }
    .prod .thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
    .prod .thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; }
    .prod .price-big { font-size: 1.6rem; font-weight: 700; color: var(--accent-hover); margin: 8px 0; }
    .prod .facts { margin: 18px 0; padding: 0; list-style: none; font-size: 0.92rem; }
    .prod .facts li { padding: 6px 0; border-bottom: 1px solid var(--border-color); }
    .badge-stock { display: inline-block; font-size: 0.78rem; font-weight: 700; padding: 3px 10px; border-radius: 20px; }
    .badge-stock.in { background: #e9f7ee; color: #1e6b34; }
    .badge-stock.out { background: #fdeceb; color: #a12d27; }
  </style>
${extra}
</head>
<body>
  <header class="kd-header">
    <a href="/" class="brand-logo">KD Wisdom <span>Enterprise</span></a>
    <nav class="kd-nav">
      <a href="/">Shop</a>
      <a href="/shop/">Categories</a>
      <a href="/#wholesale">Wholesale</a>
      <a href="/messages.html"><i class="fa-regular fa-comments"></i> Chat</a>
      <a href="/account.html"><i class="fa-regular fa-user"></i> Account</a>
    </nav>
  </header>
`;
}

const footer = `
  <footer class="kd-footer">
    <p>${BRAND} · ${AREA} · <a href="tel:${PHONE_INTL}">${PHONE_LOCAL}</a></p>
    <p style="margin-top:8px;"><a href="/">Shop</a> · <a href="/shop/">All Categories</a> · <a href="/about.html">About Us</a> · <a href="/account.html">My Account</a> · <a href="/refund-policy.html">Refund &amp; Delivery Policy</a></p>
    <p style="margin-top:8px;">&copy; 2026 ${BRAND}. All Rights Reserved.</p>
  </footer>
</body>
</html>
`;

function card(p, ctx) {
  const img = imagesOf(p)[0];
  return `      <a class="seo-card" href="${ctx.productUrl(p)}">
        ${img ? `<img src="${esc(img)}" alt="${esc(p.name)} - ${esc(ctx.catName(p))} in ${CITY}" loading="lazy" width="400" height="500">` : ''}
        <div class="body">
          <h3>${esc(p.name)}</h3>
          <div class="price">GHS ${money(p.price)}</div>
          ${Number(p.stock) > 0 ? '' : '<div class="sold">Sold out</div>'}
        </div>
      </a>`;
}

// ---------- build ----------
const { products: rawProducts, categories: rawCategories } = await load();
const categories = (rawCategories && rawCategories.length ? rawCategories : DEFAULT_CATEGORIES)
  .map((c) => ({ key: c.key, label: c.label, sort_order: c.sort_order || 0 }));

const products = rawProducts.filter((p) => p && p.id && p.name && Number(p.price) > 0);

// Category pages: only categories that have at least one product (no empty pages)
const catInfo = new Map();
categories.forEach((c) => {
  const seoName = `Men's ${c.label}`;
  catInfo.set(c.key, { ...c, seoName, slug: 'mens-' + slugify(c.label), items: [] });
});
products.forEach((p) => { const c = catInfo.get(normCat(p.category)); if (c) c.items.push(p); });
const activeCats = [...catInfo.values()].filter((c) => c.items.length > 0);

const slugs = new Map();
products.forEach((p) => slugs.set(p.id, `${slugify(p.name) || 'item'}-${String(p.id).replace(/-/g, '').slice(0, 8)}`));
const ctx = {
  productUrl: (p) => `/product/${slugs.get(p.id)}/`,
  catName: (p) => (catInfo.get(normCat(p.category)) || { seoName: "Men's Clothing" }).seoName
};

// start clean so deleted products disappear
fs.rmSync('shop', { recursive: true, force: true });
fs.rmSync('product', { recursive: true, force: true });
const urls = [
  { loc: `${SITE}/`, pri: '1.0', freq: 'weekly' },
  { loc: `${SITE}/shop/`, pri: '0.9', freq: 'weekly' },
  { loc: `${SITE}/about.html`, pri: '0.8', freq: 'monthly' },
  { loc: `${SITE}/faq.html`, pri: '0.7', freq: 'monthly' },
  { loc: `${SITE}/contact.html`, pri: '0.7', freq: 'monthly' },
  { loc: `${SITE}/terms.html`, pri: '0.5', freq: 'monthly' },
  { loc: `${SITE}/refund-policy.html`, pri: '0.5', freq: 'monthly' }
];

const catLinks = (current) => `<div class="chips-row">${activeCats.filter((c) => c.key !== current)
  .map((c) => `<a href="/shop/${c.slug}/">${esc(c.seoName)}</a>`).join('')}</div>`;

// ----- category pages -----
for (const c of activeCats) {
  const url = `${SITE}/shop/${c.slug}/`;
  const n = c.items.length;
  const intro = `Shop ${c.seoName.toLowerCase()} in ${CITY}, Ghana at ${BRAND}, ${AREA}. Browse ${n} ${n === 1 ? 'style' : 'styles'} in sizes ${SIZES[0]} to ${SIZES[SIZES.length - 1]}, order online and pay with Mobile Money or card, with delivery across Ghana or free pickup at our shop. Buy 3 or more of the same style and the wholesale price applies.`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Shop', item: `${SITE}/shop/` },
      { '@type': 'ListItem', position: 3, name: c.seoName, item: url }] },
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${c.seoName} in ${CITY}, Ghana`, url, description: intro,
      mainEntity: { '@type': 'ItemList', itemListElement: c.items.slice(0, 50).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + ctx.productUrl(p), name: p.name })) } }
  ];
  const html = head({ title: `${c.seoName} in ${CITY}, Ghana | ${BRAND}`, description: intro, canonical: url, image: imagesOf(c.items[0])[0], extra: ld.map(jsonLd).join('\n') }) + `
  <main class="page">
    <div class="crumbs"><a href="/">Home</a> › <a href="/shop/">Shop</a> › ${esc(c.seoName)}</div>
    <h1>${esc(c.seoName)} in ${CITY}, Ghana</h1>
    <p class="seo-intro">${esc(intro)}</p>
    <div class="seo-grid">
${c.items.map((p) => card(p, ctx)).join('\n')}
    </div>
    <h2 style="margin-top:34px;font-size:1.1rem;">More from ${BRAND}</h2>
    ${catLinks(c.key)}
  </main>
` + footer;
  write(`shop/${c.slug}/index.html`, html);
  urls.push({ loc: url, pri: '0.8', freq: 'weekly' });
}

// ----- shop hub page -----
{
  const url = `${SITE}/shop/`;
  const intro = `${BRAND} is a men's clothing shop at ${AREA}. Browse jeans, shirts, shorts, trousers, sweatpants and more. Order online, pay with Mobile Money or card, and get delivery across Ghana or pick up at our shop.`;
  const html = head({ title: `Men's Clothing in ${CITY}, Ghana - Shop by Category | ${BRAND}`, description: intro, canonical: url }) + `
  <main class="page">
    <div class="crumbs"><a href="/">Home</a> › Shop</div>
    <h1>Men's Clothing in ${CITY}, Ghana</h1>
    <p class="seo-intro">${esc(intro)}</p>
    <div class="seo-grid">
${activeCats.map((c) => { const img = imagesOf(c.items[0])[0];
  return `      <a class="seo-card" href="/shop/${c.slug}/">
        ${img ? `<img src="${esc(img)}" alt="${esc(c.seoName)} in ${CITY}" loading="lazy" width="400" height="500">` : ''}
        <div class="body"><h3>${esc(c.seoName)}</h3><div class="muted">${c.items.length} ${c.items.length === 1 ? 'style' : 'styles'}</div></div>
      </a>`; }).join('\n')}
    </div>
  </main>
` + footer;
  write('shop/index.html', html);
}

// ----- product pages -----
for (const p of products) {
  const cat = catInfo.get(normCat(p.category));
  const url = SITE + ctx.productUrl(p);
  const imgs = imagesOf(p);
  const inStock = Number(p.stock) > 0;
  const wsPrice = Number(p.wholesale_price) > 0 ? Number(p.wholesale_price) : 0;
  const wsMin = Math.max(parseInt(p.wholesale_min_qty, 10) || 3, 1);
  const blurb = String(p.description || '').trim() || `${p.name} from ${BRAND}.`;
  const metaDesc = `${p.name} - GHS ${money(p.price)}. ${blurb} Order online from ${BRAND}, ${AREA}. Delivery across Ghana or free pickup.`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Shop', item: `${SITE}/shop/` },
      ...(cat && cat.items.length ? [{ '@type': 'ListItem', position: 3, name: cat.seoName, item: `${SITE}/shop/${cat.slug}/` }] : []),
      { '@type': 'ListItem', position: cat && cat.items.length ? 4 : 3, name: p.name, item: url }] },
    { '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: blurb, image: imgs, sku: String(p.id).slice(0, 8),
      category: cat ? cat.seoName : "Men's Clothing", brand: { '@type': 'Brand', name: BRAND },
      offers: { '@type': 'Offer', url, priceCurrency: 'GHS', price: money(p.price),
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition',
        seller: { '@type': 'Organization', name: BRAND } } }
  ];
  const html = head({ title: `${p.name} - GHS ${money(p.price)} | ${BRAND}`, description: metaDesc, canonical: url, image: imgs[0], type: 'product', extra: ld.map(jsonLd).join('\n') }) + `
  <main class="page">
    <div class="crumbs"><a href="/">Home</a> › <a href="/shop/">Shop</a>${cat && cat.items.length ? ` › <a href="/shop/${cat.slug}/">${esc(cat.seoName)}</a>` : ''} › ${esc(p.name)}</div>
    <div class="prod">
      <div>
        ${imgs[0] ? `<img class="main-img" src="${esc(imgs[0])}" alt="${esc(p.name)} - ${esc(cat ? cat.seoName : "Men's clothing")} in ${CITY}" width="800" height="1000">` : ''}
        ${imgs.length > 1 ? `<div class="thumbs">${imgs.slice(1, 5).map((u) => `<img src="${esc(u)}" alt="${esc(p.name)} - more photos" loading="lazy" width="200" height="200">`).join('')}</div>` : ''}
      </div>
      <div>
        <h1 style="font-size:1.7rem;">${esc(p.name)}</h1>
        <div class="price-big">GHS ${money(p.price)}</div>
        <span class="badge-stock ${inStock ? 'in' : 'out'}">${inStock ? 'In stock' : 'Sold out'}</span>
        <p style="margin-top:16px;color:#444;line-height:1.7;">${esc(blurb)}</p>
        <ul class="facts">
          ${cat ? `<li><b>Category:</b> <a href="/shop/${cat.slug}/" style="color:var(--accent-hover)">${esc(cat.seoName)}</a></li>` : ''}
          <li><b>Sizes:</b> ${SIZES.join(', ')}</li>
          ${wsPrice ? `<li><b>Wholesale price:</b> GHS ${money(wsPrice)} each when you buy ${wsMin} or more of this style (any sizes)</li>` : ''}
          <li><b>Pay with:</b> Mobile Money (MTN, Telecel, AirtelTigo) or card</li>
          <li><b>Delivery:</b> across Ghana, fee shown before you order, or free pickup at ${AREA}</li>
        </ul>
        ${inStock ? `<a class="btn btn-primary" href="/?p=${encodeURIComponent(p.id)}"><i class="fa-solid fa-credit-card"></i> Order this item</a>` : '<a class="btn btn-outline" href="/">See other styles</a>'}
        <p class="muted" style="margin-top:14px;">Questions? <a href="/messages.html" style="color:var(--accent-hover)">Chat with us</a> or call <a href="tel:${PHONE_INTL}" style="color:var(--accent-hover)">${PHONE_LOCAL}</a>. See our <a href="/refund-policy.html" style="color:var(--accent-hover)">refund and delivery policy</a>.</p>
      </div>
    </div>
    ${cat && cat.items.length > 1 ? `<h2 style="margin-top:40px;font-size:1.1rem;">More ${esc(cat.seoName.toLowerCase())}</h2>
    <div class="seo-grid" style="margin-top:14px;">
${cat.items.filter((x) => x.id !== p.id).slice(0, 4).map((x) => card(x, ctx)).join('\n')}
    </div>` : ''}
  </main>
` + footer;
  write(`product/${slugs.get(p.id)}/index.html`, html);
  urls.push({ loc: url, pri: '0.6', freq: 'weekly' });
}

// ----- sitemap -----
const today = new Date().toISOString().slice(0, 10);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`).join('\n')}
</urlset>
`);

console.log(`Done: ${activeCats.length} category pages, ${products.length} product pages, ${urls.length} addresses in sitemap.xml`);
console.log('Now upload the "shop" and "product" folders and sitemap.xml to GitHub in one commit.');
