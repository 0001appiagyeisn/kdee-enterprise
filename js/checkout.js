import { supabase, WHATSAPP_NUMBER } from './supabase-config.js';
import { cartKey, adoptGuestCart } from './cart-store.js';
import { initPhoneInputs, setPhone, isValidGhPhone } from './phone-input.js';
import { searchPlaces, parseCoords, looksLikeMapLink } from './place-search.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ORDER_TYPE = 'retail'; // one shopping bag for everything; wholesale prices are applied per item
let CART_KEY = cartKey(ORDER_TYPE, 'guest'); // switched to the logged-in account's cart in init()

let user = null;
let onlinePayments = false; // set from the shop's settings (admin -> Delivery & Settings)
let profile = null;
let settings = null;
let cart = [];
let method = 'pickup';
let payMethod = 'momo';
let pin = null;          // { lat, lng }
let quote = null;        // server delivery quote
let quoteSeq = 0;
let map = null;
let pinMarker = null;
let currentRef = null;
let polling = false;

const money = (n) => 'GHS ' + Number(n || 0).toFixed(2);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('233')) d = '0' + d.slice(3); if (d.length === 9) d = '0' + d; return d; };
const validPhone = isValidGhPhone;
const NETWORKS = { mtn: 'MTN MoMo', vod: 'Telecel Cash', atl: 'AirtelTigo Money' };

function showAlert(id, text, type = 'error') {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'alert' + (text ? ` show ${type}` : '');
}

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : (v ?? fallback); }
  catch (e) { return fallback; }
}

// Calls a Supabase Edge Function and turns any error into a readable message
async function callFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ---------- Summary ----------
// Same rule as the shop: 3+ pieces of an item (any sizes) = wholesale price. The server checks it again.
const wsMinOf = (it) => Math.max(parseInt(it.wsMin, 10) || 3, 1);
const productQty = (id) => cart.reduce((s, it) => s + (it.id === id ? Number(it.qty) : 0), 0);
const unitPrice = (it) => (Number(it.wsPrice) > 0 && productQty(it.id) >= wsMinOf(it) ? Number(it.wsPrice) : Number(it.price));

function subtotal() {
  return cart.reduce((s, it) => s + unitPrice(it) * Number(it.qty), 0);
}

function renderSummary() {
  const line = (it) => `
    <div class="summary-item">
      <img src="${escapeHtml(it.img || '')}" alt="">
      <div class="info">
        <h4>${escapeHtml(it.name)}</h4>
        <small>Size ${escapeHtml(it.size || '-')}${it.color ? ' · Color: ' + escapeHtml(it.color) : ''} · ${it.qty} × ${money(unitPrice(it))}</small>
      </div>
      <div class="amt">${money(unitPrice(it) * it.qty)}</div>
    </div>`;
  const ws = cart.filter((it) => unitPrice(it) !== Number(it.price));
  const regular = cart.filter((it) => unitPrice(it) === Number(it.price));
  $('summary-items').innerHTML =
    (ws.length ? '<p class="muted" style="margin:6px 0 2px;font-weight:700;text-transform:uppercase;font-size:0.72rem;">Wholesale price</p>' + ws.map(line).join('') : '') +
    (regular.length ? `<p class="muted" style="margin:${ws.length ? 14 : 6}px 0 2px;font-weight:700;text-transform:uppercase;font-size:0.72rem;">Regular price</p>` + regular.map(line).join('') : '');
  updateTotals();
}

function updateTotals() {
  const sub = subtotal();
  let fee = 0;
  if (method === 'delivery') {
    fee = quote ? Number(quote.fee) : 0;
    $('t-delivery').textContent = quote ? money(fee) : 'Choose location';
  } else {
    $('t-delivery').textContent = 'Free (pickup)';
  }
  $('t-subtotal').textContent = money(sub);
  $('t-total').textContent = money(sub + fee);
  $('pay-label').textContent = onlinePayments ? `Pay ${money(sub + fee)}` : 'Send order on WhatsApp';
}

// ---------- Pickup / delivery ----------
function setMethod(m) {
  method = m;
  document.querySelectorAll('input[name="method"]').forEach((r) => { r.checked = r.value === m; });
  $('opt-pickup').classList.toggle('selected', m === 'pickup');
  $('opt-delivery').classList.toggle('selected', m === 'delivery');
  $('delivery-box').hidden = m !== 'delivery';
  if (m === 'delivery') initMap();
  updateTotals();
}
document.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener('change', () => setMethod(r.value)));

function initMap() {
  if (map || typeof L === 'undefined') { if (map) setTimeout(() => map.invalidateSize(), 50); return; }
  const shop = [settings.shop_lat, settings.shop_lng];
  map = L.map('map').setView(shop, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  L.circleMarker(shop, { radius: 9, color: '#121212', fillColor: '#d4af37', fillOpacity: 1, weight: 3 })
    .addTo(map).bindTooltip('KD Wisdom Enterprise (shop)', { permanent: false });
  map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng, true));
  setTimeout(() => map.invalidateSize(), 100);
}

function setPin(lat, lng, fillAddress) {
  pin = { lat, lng };
  if (!pinMarker) {
    pinMarker = L.circleMarker([lat, lng], { radius: 10, color: '#d4af37', fillColor: '#121212', fillOpacity: 1, weight: 3 }).addTo(map);
  } else {
    pinMarker.setLatLng([lat, lng]);
  }
  pinMarker.bindTooltip('Deliver here').openTooltip();
  map.setView([lat, lng], Math.max(map.getZoom(), 14));
  if (fillAddress && !$('c-address').value.trim()) reverseGeocode(lat, lng);
  getQuote();
}

function estimateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 1.35; // account for Ghana road routes
}

function calculateClientQuote(km, minutes) {
  const st = settings || {};
  let transportLocal = {};
  try { transportLocal = JSON.parse(localStorage.getItem('kd_transport_settings') || '{}'); } catch(e) {}

  const base = Number(st.base_fee) || 10;
  const minFee = Number(st.min_fee) || 20;
  const perKm = Number(st.per_km) || 1.5;
  const perMin = Number(st.per_minute) || 0.3;
  const longThreshold = Number(st.long_km_threshold) || 35;
  const longPerKm = Math.max(Number(st.long_per_km) || 0.8, 0.4);
  const terrainFactor = Math.max(Number(st.terrain_factor ?? transportLocal.terrain_factor) || 1.25, 1.0);
  const intercityFee = Number(st.intercity_flat_fee ?? transportLocal.intercity_flat_fee) || 50;
  const intercityEnabled = (st.intercity_enabled ?? transportLocal.intercity_enabled) !== false;
  const step = Number(st.round_to) > 0 ? Number(st.round_to) : 5;

  if (intercityEnabled && km > 35) {
    let fee = intercityFee;
    if (km > 100) fee += Math.ceil((km - 100) / 50) * 5;
    return Math.ceil(fee / step) * step;
  }

  const bufferedMinutes = minutes * terrainFactor;
  const near = Math.min(km, longThreshold);
  const far = Math.max(km - longThreshold, 0);
  let fee = base + (near * perKm) + (far * longPerKm) + (bufferedMinutes * perMin);
  fee = Math.max(fee, minFee);
  return Math.ceil(fee / step) * step;
}

async function getQuote() {
  if (!pin) return;
  const seq = ++quoteSeq;
  quote = null;
  updateTotals();
  const box = $('quote-box');
  box.className = 'quote-box show';
  box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calculating delivery fee...';
  try {
    const res = await callFn('checkout', { action: 'quote', delivery: { method: 'delivery', lat: pin.lat, lng: pin.lng } });
    if (seq !== quoteSeq) return;
    quote = res.delivery;
    // If distance is intercity (> 35 km), apply bus parcel rate if more fair
    if (quote && quote.km > 35) {
      const fairIntercity = calculateClientQuote(quote.km, quote.minutes);
      if (fairIntercity > 0) quote.fee = fairIntercity;
    }
    const hrs = Math.floor(quote.minutes / 60), mins = quote.minutes % 60;
    const time = hrs ? `${hrs} h ${mins} min` : `${mins} min`;
    box.innerHTML = `<b>Delivery fee: ${money(quote.fee)}</b><br>About ${quote.km} km · roughly ${time} from our shop${quote.source === 'google' ? ' (with current traffic)' : (quote.source === 'estimate' ? ' (estimated)' : '')}.`;
  } catch (err) {
    if (seq !== quoteSeq) return;
    // Client-side fallback using shop settings and road distance formula
    const shop = shopPoint();
    const km = Math.max(parseFloat(estimateDistanceKm(shop.lat, shop.lng, pin.lat, pin.lng).toFixed(1)), 1);
    const speedKmH = km > 35 ? 55 : (km > 15 ? 35 : 25);
    const minutes = Math.max(Math.round((km / speedKmH) * 60), 10);
    const fee = calculateClientQuote(km, minutes);
    quote = { fee, km, minutes, source: 'estimate' };
    const hrs = Math.floor(minutes / 60), mins = minutes % 60;
    const time = hrs ? `${hrs} h ${mins} min` : `${mins} min`;
    box.innerHTML = `<b>Delivery fee: ${money(fee)}</b><br>About ${km} km · roughly ${time} from our shop (estimated).`;
  }
  updateTotals();
}

async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lng}`);
    const d = await r.json();
    if (d && d.display_name && !$('c-address').value.trim()) {
      $('c-address').value = d.display_name.split(',').slice(0, 3).join(',').trim();
    }
  } catch (e) { /* the customer can type it */ }
}

const shopPoint = () => ({ lat: Number(settings.shop_lat), lng: Number(settings.shop_lng) });
const cityHint = () => String(settings.shop_address || 'Kumasi').split(',').pop().trim();

async function searchPlace() {
  const q = $('place-search').value.trim();
  const list = $('search-results');
  if (q.length < 2) return;
  if (parseCoords(q) || looksLikeMapLink(q)) { $('link-input').value = q; return useLink(); } // a link pasted in the search box
  list.className = 'search-results show';
  list.innerHTML = '<li>Searching...</li>';
  try {
    const results = await searchPlaces(q, shopPoint(), cityHint());
    if (!results.length) {
      list.innerHTML = '<li>No places found. Try a nearby landmark or the town name, paste a Google Maps link below, or tap the map.</li>';
      return;
    }
    list.innerHTML = '';
    results.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.km != null ? ` (${p.km < 10 ? p.km.toFixed(1) : Math.round(p.km)} km from shop)` : '');
      li.addEventListener('click', () => {
        list.className = 'search-results';
        if (!$('c-address').value.trim()) $('c-address').value = p.name.split(',').slice(0, 3).join(',').trim();
        setPin(p.lat, p.lng, false);
      });
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = '<li>Search is not available right now. Please tap the map or paste a Google Maps link.</li>';
  }
}
$('place-search-btn').addEventListener('click', searchPlace);
$('place-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPlace(); } });

// Google Maps link or coordinates -> pin
async function useLink() {
  const text = $('link-input').value.trim();
  const msg = $('link-msg');
  if (!text) return;
  initMap();
  let point = parseCoords(text);
  if (!point && looksLikeMapLink(text)) {
    msg.textContent = 'Reading the link...';
    try { point = (await callFn('checkout', { action: 'resolve_link', url: text })).location; }
    catch (err) { msg.textContent = err.message; return; }
  }
  if (!point) { msg.textContent = 'That is not a Google Maps link or coordinates. Example: 6.6966, -1.6225'; return; }
  msg.textContent = '✅ Location set from your link. Check the pin, then describe the place below.';
  $('search-results').className = 'search-results';
  setPin(point.lat, point.lng, true);
}
$('link-btn').addEventListener('click', useLink);
$('link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useLink(); } });
$('link-input').addEventListener('paste', () => setTimeout(useLink, 50));

$('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Your browser cannot share your location. Please search or tap the map.');
  const btn = $('locate-btn');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => { btn.disabled = false; setPin(pos.coords.latitude, pos.coords.longitude, true); },
    () => { btn.disabled = false; alert('Could not get your location. Please allow location access, or search / tap the map.'); },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

// ---------- Payment method ----------
function setPayMethod(m) {
  payMethod = m;
  $('opt-momo').classList.toggle('selected', m === 'momo');
  $('opt-card').classList.toggle('selected', m === 'paystack');
  $('momo-box').hidden = m !== 'momo';
}
document.querySelectorAll('input[name="pay"]').forEach((r) => r.addEventListener('change', () => setPayMethod(r.value)));

function fillSavedMomo() {
  const accounts = Array.isArray(profile?.momo_accounts) ? profile.momo_accounts : [];
  if (!accounts.length) return;
  $('saved-momo-field').hidden = false;
  const sel = $('saved-momo');
  sel.innerHTML = accounts.map((a, i) => `<option value="${i}">${escapeHtml(NETWORKS[a.network] || a.network)} · ${escapeHtml(a.number)}</option>`).join('') +
    '<option value="new">Use another number</option>';
  const def = Math.max(0, accounts.findIndex((a) => a.is_default));
  sel.value = String(def);
  const apply = () => {
    const a = accounts[Number(sel.value)];
    if (a) { $('momo-network').value = a.network; setPhone($('momo-number'), a.number); }
    else { setPhone($('momo-number'), ''); }
  };
  sel.addEventListener('change', apply);
  apply();
}

async function saveMomoIfNew(network, number) {
  if (!$('momo-save').checked) return;
  const accounts = Array.isArray(profile?.momo_accounts) ? [...profile.momo_accounts] : [];
  if (accounts.some((a) => a.number === number && a.network === network) || accounts.length >= 5) return;
  accounts.push({ network, number, is_default: accounts.length === 0 });
  await supabase.from('profiles').update({ momo_accounts: accounts }).eq('id', user.id);
}

// ---------- Pay ----------
$('pay-btn').addEventListener('click', async () => {
  showAlert('pay-alert', '');
  const name = $('c-name').value.trim();
  const phone = $('c-phone').value.trim();
  if (!name) return showAlert('pay-alert', 'Please enter your name.');
  if (!validPhone(phone)) return showAlert('pay-alert', 'Please enter a valid 10-digit phone number starting with 0.');
  if (method === 'delivery') {
    if (!pin) return showAlert('pay-alert', 'Please choose your delivery location on the map.');
    if (!quote) return showAlert('pay-alert', 'Please wait for the delivery fee, or choose another location.');
    if ($('c-address').value.trim().length < 3) return showAlert('pay-alert', 'Please describe the delivery location (area, street or landmark).');
  }
  let momo = '';
  const network = $('momo-network').value;
  if (onlinePayments && payMethod === 'momo') {
    momo = localPhone($('momo-number').value);
    if (!isValidGhPhone(momo)) return showAlert('pay-alert', 'Please enter your 10-digit Mobile Money number (starts with 0).');
  }
  if (!$('agree').checked) return showAlert('pay-alert', 'Please agree to the Refund & Delivery Policy.');
  if (!onlinePayments) return sendWhatsAppOrder(name, phone);

  let notes = $('c-notes').value.trim();
  if (ORDER_TYPE === 'wholesale') {
    const sizes = (localStorage.getItem('kd_ws_sizes') || '').trim();
    if (sizes) notes = `Sizes: ${sizes}${notes ? ' | ' + notes : ''}`;
  }

  const btn = $('pay-btn');
  btn.disabled = true;
  $('pay-label').textContent = 'Please wait...';
  try {
    if (payMethod === 'momo') await saveMomoIfNew(network, momo);
    const res = await callFn('checkout', {
      action: 'create',
      order_type: ORDER_TYPE,
      items: cart.map((it) => ({ id: it.id, size: it.size || '', color: it.color || '', qty: it.qty })),
      customer: { name, phone },
      delivery: method === 'delivery'
        ? { method: 'delivery', lat: pin.lat, lng: pin.lng, address: $('c-address').value.trim() }
        : { method: 'pickup' },
      notes,
      payment: payMethod === 'momo' ? { method: 'momo', provider: network, phone: momo } : { method: 'paystack' },
      return_url: new URL('order.html', location.href).href
    });
    currentRef = res.reference;

    if (res.mode === 'redirect' && res.authorization_url) {
      location.href = res.authorization_url;
      return;
    }
    showWaiting(res);
  } catch (err) {
    showAlert('pay-alert', err.message);
    btn.disabled = false;
    updateTotals();
  }
});

// ---------- WhatsApp ordering (used while online payments are switched off) ----------
function sendWhatsAppOrder(name, phone) {
  const sub = subtotal();
  const fee = method === 'delivery' && quote ? Number(quote.fee) : 0;
  let msg = `*New Order - KD Wisdom Enterprise*\n\n*Customer:* ${name}\n*Phone:* ${phone}\n`;
  if (method === 'delivery') {
    msg += `*Delivery to:* ${$('c-address').value.trim()}\n`;
    if (pin) msg += `*Map pin:* https://www.google.com/maps?q=${pin.lat.toFixed(6)},${pin.lng.toFixed(6)}\n`;
    msg += `*Delivery fee:* ${money(fee)}${quote ? ` (about ${quote.km} km)` : ''}\n`;
  } else {
    msg += `*Pickup:* at the shop\n`;
  }
  msg += `\n*Items:*\n`;
  cart.forEach((it, i) => {
    msg += `${i + 1}. ${it.name} - Size ${it.size || '-'}${it.color ? ' (' + it.color + ')' : ''} (${it.qty}x @ ${money(unitPrice(it))}) = ${money(unitPrice(it) * it.qty)}\n`;
  });
  msg += `\n*Subtotal:* ${money(sub)}\n*Total:* ${money(sub + fee)}`;
  const notes = $('c-notes').value.trim();
  if (notes) msg += `\n*Notes:* ${notes}`;
  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank');
  showAlert('pay-alert', 'WhatsApp is opening. Press Send there to place your order. We will confirm the total and arrange payment with you.', 'info');
}

function applyWhatsAppMode() {
  $('payment-card').hidden = true;
  $('receipt-note').hidden = true;
  $('lead-text').textContent = 'Send your order to us on WhatsApp. We will confirm it and arrange payment with you.';
  $('pay-note').textContent = 'You will be taken to WhatsApp to send your order. Nothing is charged on this page.';
  document.querySelector('#pay-btn i').className = 'fa-brands fa-whatsapp';
  $('pay-btn').style.background = '#25D366';
}

function showWaiting(res) {
  $('checkout-box').hidden = true;
  $('wait-box').hidden = false;
  $('wait-back').hidden = true;
  showAlert('wait-alert', '');
  window.scrollTo(0, 0);
  const amount = res.total ? ` of ${money(res.total)}` : '';
  $('wait-text').textContent = res.display_text ||
    `Approve the payment${amount} on your phone by entering your MoMo PIN.`;
  $('otp-box').hidden = res.status !== 'send_otp';
  if (res.status === 'failed') {
    showAlert('wait-alert', 'The payment could not start. Please check the number and network, then try again.');
    $('wait-back').hidden = false;
    return;
  }
  pollPayment();
}

$('otp-btn').addEventListener('click', async () => {
  const otp = $('otp').value.trim();
  if (!otp) return;
  $('otp-btn').disabled = true;
  try {
    const res = await callFn('checkout', { action: 'submit_otp', reference: currentRef, otp });
    $('otp-box').hidden = res.status === 'pay_offline' || res.status === 'success';
    if (res.display_text) $('wait-text').textContent = res.display_text;
    if (res.status === 'failed') showAlert('wait-alert', 'That code was not accepted. Please try again.');
  } catch (err) {
    showAlert('wait-alert', err.message);
  }
  $('otp-btn').disabled = false;
});

async function pollPayment() {
  polling = true;
  const started = Date.now();
  while (polling && Date.now() - started < 4 * 60 * 1000) {
    await sleep(5000);
    if (!polling) return;
    try {
      const r = await callFn('paystack-verify', { reference: currentRef });
      if (r.order && r.order.status !== 'pending_payment') {
        polling = false;
        localStorage.removeItem(CART_KEY);
        if (ORDER_TYPE === 'wholesale') localStorage.removeItem('kd_ws_sizes');
        location.href = `order.html?reference=${encodeURIComponent(currentRef)}`;
        return;
      }
      if (r.payment_status === 'failed') {
        polling = false;
        showAlert('wait-alert', (r.message ? r.message + '. ' : '') + 'The payment was declined or cancelled. You can go back and try again.');
        $('wait-back').hidden = false;
        return;
      }
    } catch (e) { /* network hiccup, keep waiting */ }
  }
  if (polling) {
    polling = false;
    showAlert('wait-alert', "We haven't received the payment yet. If you approved it, it can take a few minutes — check My Orders in your account. Otherwise go back and try again.", 'info');
    $('wait-back').hidden = false;
  }
}

$('wait-back').addEventListener('click', () => {
  polling = false;
  $('wait-box').hidden = true;
  $('checkout-box').hidden = false;
  $('pay-btn').disabled = false;
  updateTotals();
});

// ---------- Start ----------
async function init() {
  const [{ data: { session } }, { data: st }] = await Promise.all([
    supabase.auth.getSession(),
    supabase.from('store_settings').select('*').eq('id', 1).maybeSingle()
  ]);
  settings = st || { shop_lat: 6.6966, shop_lng: -1.6225, shop_address: 'Kejetia Market, Kumasi', pickup_enabled: true, delivery_enabled: true };

  // Online payments: ON for everyone when the admin switches them on; admins can always try them for testing
  onlinePayments = settings.online_payments_enabled === true;
  let adminTest = false;
  if (session && !onlinePayments) {
    const { data: isAdm } = await supabase.rpc('is_admin');
    adminTest = isAdm === true;
    onlinePayments = adminTest;
  }

  if (!session && onlinePayments) {
    location.href = 'account.html?next=' + encodeURIComponent('checkout.html' + location.search);
    return;
  }
  user = session ? session.user : null;
  if (user) adoptGuestCart(user.id);
  CART_KEY = cartKey(ORDER_TYPE, user ? user.id : 'guest');
  initPhoneInputs();

  cart = readJSON(CART_KEY, []).filter((it) => it && it.id && Number(it.qty) > 0);
  if (cart.length === 0) { $('empty-box').hidden = false; return; }

  const prof = user ? (await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()).data : null;
  profile = prof || {};

  $('c-name').value = profile.full_name || user?.user_metadata?.full_name || '';
  setPhone($('c-phone'), profile.phone || user?.user_metadata?.phone || '');
  $('c-email').textContent = user ? user.email : '';
  if (profile.address) $('c-address').value = profile.address;
  $('shop-address').textContent = settings.shop_address || 'Kejetia Market, Kumasi';

  if (!settings.pickup_enabled) $('opt-pickup').hidden = true;
  if (!settings.delivery_enabled) $('opt-delivery').hidden = true;

  if (!onlinePayments) applyWhatsAppMode();
  if (adminTest) showAlert('mode-banner', 'Admin test mode: online payments are switched OFF for customers, but you can test them here.', 'info');

  $('checkout-box').hidden = false;
  renderSummary();
  setMethod(settings.pickup_enabled ? 'pickup' : 'delivery');
  setPayMethod('momo');
  if (onlinePayments) fillSavedMomo();
}

init();
