// Admin: Photo Optimizer. Shrinks the big photos already in your shop (one-time clean-up).
// Runs in your browser while you are logged in as admin. For each big photo it:
//   1. downloads it, 2. makes a smaller copy (max 1280 px, JPEG), 3. uploads the copy,
//   4. checks the copy opens, 5. points the product at the copy, 6. (optional) deletes the big original.
// If anything fails for a photo, that photo is left exactly as it was.
import { supabase } from './supabase-config.js';

const $ = (id) => document.getElementById(id);
const BUCKET = 'product-images';
const BIG = 350 * 1024; // photos larger than this get optimized
const MAX_SIZE = 1280;
const QUALITY = 0.82;

let products = [];
let plan = [];
let running = false;
let stopRequested = false;

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const urlsOf = (p) => (Array.isArray(p.images) && p.images.length ? p.images : (p.image_url ? [p.image_url] : [])).filter(Boolean);
const inBucket = (u) => typeof u === 'string' && u.includes(`/${BUCKET}/`);
const pathOf = (u) => decodeURIComponent(u.split(`/${BUCKET}/`)[1].split('?')[0]);

function log(text) {
  const el = $('photo-log');
  el.textContent += text + '\n';
  el.scrollTop = el.scrollHeight;
}

async function compress(file, maxSize = MAX_SIZE, quality = QUALITY) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('could not make a smaller copy');
  return blob;
}

async function sizeOf(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const n = parseInt(r.headers.get('content-length') || '0', 10);
    if (r.ok && n) return n;
  } catch (e) { /* fall back below */ }
  try { return (await (await fetch(url)).blob()).size; } catch (e) { return 0; }
}

async function isAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return false;
  const { data } = await supabase.rpc('is_admin');
  return data === true;
}

// ---------- 1. Scan ----------
async function scan() {
  if (running) return;
  if (!(await isAdmin())) { $('photo-status').textContent = '⚠️ Log in as admin first.'; return; }
  $('photo-scan').disabled = true;
  $('photo-run').hidden = true;
  $('photo-del-wrap').hidden = true;
  $('photo-log').textContent = '';
  $('photo-status').textContent = 'Reading your products...';

  const { data, error } = await supabase.from('products').select('id,name,images,image_url');
  if (error) { $('photo-status').textContent = '⚠️ ' + error.message; $('photo-scan').disabled = false; return; }
  products = data || [];

  const urls = [...new Set(products.flatMap(urlsOf).filter(inBucket))];
  const sizes = new Map();
  let done = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      sizes.set(u, await sizeOf(u));
      done++;
      $('photo-status').textContent = `Checking photo sizes... ${done}/${urls.length}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  plan = urls.map((u) => ({ url: u, size: sizes.get(u) || 0 })).filter((x) => x.size > BIG).sort((a, b) => b.size - a.size);
  const total = urls.reduce((s, u) => s + (sizes.get(u) || 0), 0);
  const bigTotal = plan.reduce((s, x) => s + x.size, 0);

  $('photo-scan').disabled = false;
  if (plan.length === 0) {
    $('photo-status').textContent = `✅ All ${urls.length} photos are already small (${mb(total)} in total). Nothing to do.`;
    return;
  }
  $('photo-status').textContent = `Found ${plan.length} large photos (${mb(bigTotal)}) out of ${urls.length}. Most of that can be saved.`;
  $('photo-run').hidden = false;
  $('photo-run').textContent = `Optimize ${plan.length} photos`;
  $('photo-del-wrap').hidden = false;
}

// ---------- 2. Optimize ----------
async function run() {
  if (running || !plan.length) return;
  running = true;
  stopRequested = false;
  const deleteOld = $('photo-delete').checked;
  $('photo-run').hidden = true;
  $('photo-scan').disabled = true;
  $('photo-stop').hidden = false;
  $('photo-bar').hidden = false;
  $('photo-log').textContent = '';

  let saved = 0;
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < plan.length; i++) {
    if (stopRequested) { log('Stopped. Click Scan to continue later.'); break; }
    const { url } = plan[i];
    $('photo-status').textContent = `Optimizing ${i + 1}/${plan.length}... please keep this page open`;
    $('photo-bar-fill').style.width = `${Math.round((i / plan.length) * 100)}%`;
    const label = pathOf(url).slice(-28);

    try {
      const original = await (await fetch(url)).blob();
      const small = await compress(original);
      if (small.size >= original.size * 0.9) { log(`• ${label}: already efficient, skipped`); continue; }

      const name = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(name, small, { contentType: 'image/jpeg' });
      if (upErr) throw new Error('upload: ' + upErr.message);
      const newUrl = supabase.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;

      // The new photo must open before any product points to it
      const check = await fetch(newUrl, { method: 'HEAD' });
      if (!check.ok) {
        await supabase.storage.from(BUCKET).remove([name]);
        throw new Error('new copy did not open');
      }

      // Point every product that uses the old photo at the new one
      const users = products.filter((p) => urlsOf(p).includes(url));
      for (const p of users) {
        const images = urlsOf(p).map((u) => (u === url ? newUrl : u));
        const { error } = await supabase.from('products').update({ images, image_url: images[0] }).eq('id', p.id);
        if (error) throw new Error('product update: ' + error.message);
        p.images = images;
        p.image_url = images[0];
      }

      // Delete the big original only if no product still uses it
      if (deleteOld && !products.some((p) => urlsOf(p).includes(url))) {
        const { error } = await supabase.storage.from(BUCKET).remove([pathOf(url)]);
        if (error) log(`  (could not delete original: ${error.message})`);
      }

      saved += original.size - small.size;
      ok++;
      log(`✓ ${label}: ${mb(original.size)} → ${mb(small.size)}`);
    } catch (err) {
      failed++;
      log(`✗ ${label}: ${err.message} (left unchanged)`);
    }
  }

  $('photo-bar-fill').style.width = '100%';
  $('photo-stop').hidden = true;
  $('photo-scan').disabled = false;
  running = false;
  $('photo-status').textContent = `Done: ${ok} photos optimized, ${mb(saved)} saved${failed ? `, ${failed} left unchanged` : ''}.`;
  log('Finished. Refresh your shop to see the faster photos. If you use the SEO page builder, run it again so product pages use the new photo addresses.');
  plan = [];
}

$('photo-scan')?.addEventListener('click', scan);
$('photo-run')?.addEventListener('click', run);
$('photo-stop')?.addEventListener('click', () => { stopRequested = true; });
