// Admin: Orders, Customers and Settings tabs (works alongside admin.js, which handles login + inventory)
import { supabase } from './supabase-config.js';
import { initPhoneInputs, setPhone, isValidGhPhone } from './phone-input.js';
import { searchPlaces, parseCoords, looksLikeMapLink } from './place-search.js';

const $ = (id) => document.getElementById(id);
const STATUS = {
  pending_payment: 'Awaiting payment', paid: 'Paid – new', processing: 'Processing', ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded'
};
const PAID_STATES = ['paid', 'processing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed'];
const NEXT_STATUSES = {
  paid: ['processing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled'],
  processing: ['ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled'],
  ready_for_pickup: ['completed', 'out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'completed', 'cancelled'],
  delivered: ['completed'],
  completed: [],
  pending_payment: ['cancelled'],
  cancelled: [],
  refunded: []
};

let orders = [];
let profiles = [];
let settings = null;
let isAdmin = false;
let channel = null;

const money = (n) => 'GHS ' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const badge = (s) => `<span class="o-badge ${s}">${STATUS[s] || s}</span>`;

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

// ---------------- Tabs ----------------
function showTab(name) {
  document.querySelectorAll('.admin-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.admin-tab').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  if (!isAdmin) return;
  if (name === 'orders') loadOrders();
  if (name === 'customers') loadCustomers();
  if (name === 'settings') loadSettings();
}
document.querySelectorAll('.admin-tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------------- Orders ----------------
async function loadOrders() {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(1000);
  if (error) {
    $('orders-list').innerHTML = `<p class="img-hint">Could not load orders (${escapeHtml(error.message)}). Have you run database-update-3.sql?</p>`;
    return;
  }
  orders = data || [];
  renderStats();
  renderOrders();
}

function renderStats() {
  const now = new Date();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const paid = orders.filter((o) => PAID_STATES.includes(o.status) && o.paid_at);
  const sum = (list) => list.reduce((s, o) => s + Number(o.total || 0), 0);

  $('st-rev-today').textContent = money(sum(paid.filter((o) => new Date(o.paid_at) >= startDay)));
  $('st-rev-month').textContent = money(sum(paid.filter((o) => new Date(o.paid_at) >= startMonth)));
  $('st-to-process').textContent = orders.filter((o) => ['paid', 'processing'].includes(o.status)).length;
  $('st-out').textContent = orders.filter((o) => ['out_for_delivery', 'ready_for_pickup'].includes(o.status)).length;

  const fresh = orders.filter((o) => o.status === 'paid').length;
  $('orders-badge').textContent = fresh ? fresh : '';
  $('orders-badge').hidden = !fresh;
}

function filteredOrders() {
  const term = $('ord-search').value.trim().toLowerCase();
  const status = $('ord-status').value;
  const type = $('ord-type').value;
  return orders.filter((o) => {
    if (status === 'active' && !['paid', 'processing', 'ready_for_pickup', 'out_for_delivery'].includes(o.status)) return false;
    if (status !== 'all' && status !== 'active' && o.status !== status) return false;
    if (type !== 'all' && o.order_type !== type) return false;
    if (!term) return true;
    return [o.order_number, o.customer_name, o.customer_phone, o.customer_email, o.delivery_address]
      .join(' ').toLowerCase().includes(term);
  });
}

function renderOrders() {
  const list = filteredOrders();
  $('ord-count').textContent = `Showing ${list.length} of ${orders.length} orders`;
  const box = $('orders-list');
  if (!list.length) { box.innerHTML = '<p class="img-hint" style="text-align:center;padding:30px 0;">No orders here yet.</p>'; return; }
  box.innerHTML = '';
  list.forEach((o) => {
    const count = (o.items || []).reduce((s, it) => s + Number(it.qty || 0), 0);
    const row = document.createElement('div');
    row.className = 'order-row' + (o.status === 'paid' ? ' is-new' : '');
    row.innerHTML = `
      <div class="o-main">
        <b>${escapeHtml(o.order_number)}</b> ${badge(o.status)}
        ${o.order_type === 'wholesale' ? '<span class="o-badge wholesale">Wholesale</span>' : ''}
        <div class="o-sub">${escapeHtml(o.customer_name)} · ${escapeHtml(o.customer_phone)} · ${count} item(s)</div>
        <div class="o-sub">${o.delivery_method === 'delivery' ? '<i class="fa-solid fa-truck"></i> ' + escapeHtml(o.delivery_address || '') : '<i class="fa-solid fa-store"></i> Pickup'} · ${fmtDate(o.created_at)}</div>
      </div>
      <div class="o-total">${money(o.total)}</div>`;
    row.addEventListener('click', () => openOrder(o.id));
    box.appendChild(row);
  });
}

['ord-search', 'ord-status', 'ord-type'].forEach((id) => {
  $(id)?.addEventListener(id === 'ord-search' ? 'input' : 'change', renderOrders);
});

$('clear-test-orders-btn')?.addEventListener('click', async () => {
  const pendingOrders = orders.filter((o) => o.status === 'pending_payment');
  if (!pendingOrders.length) {
    return alert('No unpaid / test orders found to clear. All current orders have active or confirmed statuses.');
  }
  const count = pendingOrders.length;
  if (!confirm(`Found ${count} unpaid/test order(s) awaiting payment.\n\nDo you want to permanently delete these ${count} test order(s)? This will clean up your orders list.`)) {
    return;
  }
  const btn = $('clear-test-orders-btn');
  btn.disabled = true;
  btn.textContent = 'Clearing...';
  try {
    const ids = pendingOrders.map((o) => o.id);
    const { error } = await supabase.from('orders').delete().in('id', ids);
    if (error) throw error;
    orders = orders.filter((o) => !ids.includes(o.id));
    renderStats();
    renderOrders();
    alert(`Successfully deleted ${count} test order(s).`);
  } catch (err) {
    alert('Failed to clear test orders: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-broom"></i> Clear Test Orders';
  }
});

function openOrder(id) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  const shop = settings ? `${settings.shop_lat},${settings.shop_lng}` : '';
  const mapLink = o.delivery_lat
    ? `https://www.google.com/maps/dir/?api=1${shop ? '&origin=' + shop : ''}&destination=${o.delivery_lat},${o.delivery_lng}`
    : '';
  const items = (o.items || []).map((it) => `
    <tr>
      <td>${it.image ? `<img src="${escapeHtml(it.image)}" alt="">` : ''}</td>
      <td>${escapeHtml(it.name)}${it.size ? `<br><small>Size ${escapeHtml(it.size)}` : ''}${it.color ? ` · Color: ${escapeHtml(it.color)}` : ''}${it.size || it.color ? '</small>' : ''}</td>
      <td>${it.qty}</td>
      <td>${money(it.unit_price)}</td>
      <td>${money(it.line_total)}</td>
    </tr>`).join('');
  const next = NEXT_STATUSES[o.status] || [];
  const canRefund = o.paid_at && o.status !== 'refunded';

  $('order-detail').innerHTML = `
    <h2><i class="fa-solid fa-receipt"></i> ${escapeHtml(o.order_number)} ${badge(o.status)}</h2>
    ${o.admin_note ? `<div class="o-note"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(o.admin_note)}</div>` : ''}
    <div class="o-grid">
      <div><label>Customer</label>${escapeHtml(o.customer_name)}<br>
        <a href="tel:${escapeHtml(o.customer_phone)}">${escapeHtml(o.customer_phone)}</a><br>
        <small>${escapeHtml(o.customer_email)}</small></div>
      <div><label>${o.delivery_method === 'delivery' ? 'Delivery' : 'Pickup'}</label>
        ${o.delivery_method === 'delivery'
          ? `${escapeHtml(o.delivery_address || '')}<br><small>${o.delivery_km ?? '?'} km · ~${o.delivery_minutes ?? '?'} min · fee ${money(o.delivery_fee)}</small><br>${mapLink ? `<a href="${mapLink}" target="_blank" rel="noopener">Open route in Google Maps</a>` : ''}`
          : 'Customer will collect at the shop'}</div>
      <div><label>Payment</label>${o.paid_at ? `Paid ${fmtDate(o.paid_at)}` : 'Not paid'}<br><small>${escapeHtml(o.payment_channel || o.payment_method || '')} · ${escapeHtml(o.payment_reference || '')}</small></div>
      <div><label>Type</label>${o.order_type === 'wholesale' ? 'Wholesale (bulk)' : 'Retail'}<br><small>Placed ${fmtDate(o.created_at)}</small></div>
    </div>
    ${o.notes ? `<div class="o-note"><b>Customer notes:</b> ${escapeHtml(o.notes)}</div>` : ''}
    <div class="o-table-wrap"><table class="o-table">
      <tr><th></th><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>
      ${items}
      <tr><td colspan="4">Subtotal</td><td>${money(o.subtotal)}</td></tr>
      <tr><td colspan="4">Delivery</td><td>${money(o.delivery_fee)}</td></tr>
      <tr><td colspan="4"><b>Total</b></td><td><b>${money(o.total)}</b></td></tr>
      ${o.refund_amount ? `<tr><td colspan="4">Refunded${o.refund_reason ? ' (' + escapeHtml(o.refund_reason) + ')' : ''}</td><td>${money(o.refund_amount)}</td></tr>` : ''}
    </table></div>

    ${next.length ? `
    <div class="o-action">
      <h3>Update status</h3>
      <div class="o-action-row">
        <select id="od-status">${next.map((s) => `<option value="${s}">${STATUS[s]}</option>`).join('')}</select>
        <button class="btn-action btn-save" id="od-status-btn"><i class="fa-solid fa-check"></i> Update</button>
      </div>
      <label class="o-check"><input type="checkbox" id="od-notify" checked> Send SMS + email to the customer</label>
      <label class="o-check" id="od-restock-wrap"><input type="checkbox" id="od-restock" checked> Put the items back in stock (when cancelling)</label>
    </div>` : ''}

    ${canRefund ? `
    <div class="o-action">
      <h3>Refund</h3>
      <div class="o-action-row">
        <input type="number" id="od-refund-amount" step="0.01" min="0.01" max="${Number(o.total)}" value="${Number(o.total).toFixed(2)}" title="Amount in GHS">
        <input type="text" id="od-refund-reason" placeholder="Reason (customer sees this)" maxlength="200">
      </div>
      <label class="o-check"><input type="checkbox" id="od-refund-restock"> Put the items back in stock</label>
      <button class="btn-action btn-delete" id="od-refund-btn"><i class="fa-solid fa-rotate-left"></i> Refund through Paystack</button>
    </div>` : ''}

    <div class="o-action" style="border-top:1px dashed #e2e8f0;padding-top:14px;margin-top:14px;">
      <h3 style="color:#b91c1c;"><i class="fa-solid fa-trash-can"></i> Delete Order</h3>
      <p class="img-hint" style="margin-bottom:8px;">Permanently delete this order record (ideal for test orders). This cannot be undone.</p>
      <button class="btn-action btn-delete" id="od-delete-btn" style="background:#dc2626;"><i class="fa-solid fa-trash"></i> Delete This Order</button>
    </div>
    <div class="ai-status" id="od-msg" style="margin-top:12px;"></div>`;

  const statusSel = $('od-status');
  const syncRestock = () => { if ($('od-restock-wrap')) $('od-restock-wrap').hidden = statusSel.value !== 'cancelled' || !o.paid_at; };
  if (statusSel) { statusSel.addEventListener('change', syncRestock); syncRestock(); }

  $('od-status-btn')?.addEventListener('click', async () => {
    const status = statusSel.value;
    if (status === 'cancelled' && o.paid_at && !confirm('Cancel this PAID order? Remember to also refund the customer below.')) return;
    await runAction({ action: 'update_status', order_id: o.id, status, notify: $('od-notify').checked, restock: $('od-restock')?.checked }, 'Status updated.');
  });

  $('od-refund-btn')?.addEventListener('click', async () => {
    const amount = parseFloat($('od-refund-amount').value);
    if (!(amount > 0) || amount > Number(o.total)) return alert('Enter an amount between 0 and ' + money(o.total));
    if (!confirm(`Refund ${money(amount)} to the customer for ${o.order_number}? This sends the money back through Paystack.`)) return;
    await runAction({ action: 'refund', order_id: o.id, amount, reason: $('od-refund-reason').value.trim() || 'Refund', restock: $('od-refund-restock').checked }, 'Refund started.');
  });

  $('od-delete-btn')?.addEventListener('click', async () => {
    if (o.status !== 'pending_payment' && o.status !== 'cancelled') {
      const extra = confirm(`Notice: Order ${o.order_number} is currently marked as "${STATUS[o.status] || o.status}". Are you sure you want to permanently delete this order?`);
      if (!extra) return;
    } else {
      if (!confirm(`Permanently delete order ${o.order_number}? This cannot be undone.`)) return;
    }
    const btn = $('od-delete-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
      const { error } = await supabase.from('orders').delete().eq('id', o.id);
      if (error) throw error;
      orders = orders.filter((x) => x.id !== o.id);
      renderStats();
      renderOrders();
      $('order-overlay').classList.remove('active');
      alert(`Order ${o.order_number} deleted successfully.`);
    } catch (err) {
      alert('Could not delete order: ' + err.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete This Order';
    }
  });

  $('order-overlay').classList.add('active');
}

async function runAction(body, okText) {
  const msg = $('od-msg');
  msg.textContent = 'Working...';
  document.querySelectorAll('#order-detail button').forEach((b) => { b.disabled = true; });
  try {
    const res = await callFn('admin-actions', body);
    const idx = orders.findIndex((x) => x.id === body.order_id);
    if (idx >= 0 && res.order) orders[idx] = res.order;
    renderStats();
    renderOrders();
    openOrder(body.order_id);
    $('od-msg').textContent = '✅ ' + okText;
  } catch (err) {
    msg.textContent = '⚠️ ' + err.message;
    document.querySelectorAll('#order-detail button').forEach((b) => { b.disabled = false; });
  }
}

$('order-close')?.addEventListener('click', () => $('order-overlay').classList.remove('active'));
$('order-overlay')?.addEventListener('click', (e) => { if (e.target === $('order-overlay')) $('order-overlay').classList.remove('active'); });

// ---------------- Customers ----------------
async function loadCustomers() {
  if (!orders.length) await loadOrders();
  const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(2000);
  if (error) { $('customers-list').innerHTML = `<p class="img-hint">Could not load customers (${escapeHtml(error.message)}).</p>`; return; }
  profiles = data || [];
  renderCustomers();
}

function renderCustomers() {
  const term = $('cust-search').value.trim().toLowerCase();
  const stats = new Map();
  orders.forEach((o) => {
    if (!o.user_id || !PAID_STATES.includes(o.status)) return;
    const s = stats.get(o.user_id) || { count: 0, spent: 0, last: null };
    s.count += 1;
    s.spent += Number(o.total || 0);
    if (!s.last || new Date(o.paid_at) > new Date(s.last)) s.last = o.paid_at;
    stats.set(o.user_id, s);
  });
  const list = profiles.filter((p) => !term || [p.full_name, p.email, p.phone].join(' ').toLowerCase().includes(term));
  $('cust-count').textContent = `${list.length} customer account(s)`;
  const box = $('customers-list');
  if (!list.length) { box.innerHTML = '<p class="img-hint" style="text-align:center;padding:30px 0;">No customers yet.</p>'; return; }
  box.innerHTML = '';
  list.forEach((p) => {
    const s = stats.get(p.id) || { count: 0, spent: 0, last: null };
    const row = document.createElement('div');
    row.className = 'order-row';
    row.innerHTML = `
      <div class="o-main">
        <b>${escapeHtml(p.full_name || '(no name)')}</b>
        <div class="o-sub">${escapeHtml(p.email || '')} · ${escapeHtml(p.phone || 'no phone')}</div>
        <div class="o-sub">Joined ${new Date(p.created_at).toLocaleDateString('en-GB')}${s.last ? ' · Last order ' + new Date(s.last).toLocaleDateString('en-GB') : ''}</div>
      </div>
      <div class="o-total">${s.count} order(s)<br><small>${money(s.spent)}</small></div>`;
    row.title = 'Show this customer\'s orders';
    row.addEventListener('click', () => {
      $('ord-search').value = p.email || p.phone || '';
      $('ord-status').value = 'all';
      showTab('orders');
    });
    box.appendChild(row);
  });
}
$('cust-search')?.addEventListener('input', renderCustomers);

// ---------------- Settings ----------------
const SETTING_FIELDS = ['shop_address', 'shop_lat', 'shop_lng', 'base_fee', 'min_fee', 'per_km', 'per_minute', 'long_km_threshold',
  'long_per_km', 'round_to', 'max_delivery_km', 'traffic_factor', 'rush_factor', 'owner_whatsapp', 'owner_phone', 'owner_email', 'chat_forward_minutes'];
const FEE_DEFAULTS = { base_fee: 10, min_fee: 20, per_km: 1.5, per_minute: 0.3, long_km_threshold: 50, long_per_km: 0.6, round_to: 5, rush_factor: 1.5, chat_forward_minutes: 10 };

async function loadSettings() {
  const { data, error } = await supabase.from('store_settings').select('*').eq('id', 1).maybeSingle();
  if (error || !data) { $('set-msg').textContent = '⚠️ Settings not found. Run database-update-3.sql first.'; return; }
  settings = data;
  SETTING_FIELDS.forEach((f) => { $(`s-${f}`).value = data[f] ?? FEE_DEFAULTS[f] ?? ''; });
  $('s-pickup_enabled').checked = !!data.pickup_enabled;
  $('s-delivery_enabled').checked = !!data.delivery_enabled;
  $('s-online_payments_enabled').checked = data.online_payments_enabled === true;
  $('s-chat_forward_enabled').checked = data.chat_forward_enabled !== false;
  ['s-owner_whatsapp', 's-owner_phone'].forEach((id) => setPhone($(id), $(id).value));

  // Load custom terrain and intercity parcel settings (from db if columns exist, or localStorage)
  let transportLocal = {};
  try { transportLocal = JSON.parse(localStorage.getItem('kd_transport_settings') || '{}'); } catch(e) {}
  if ($('s-terrain_factor')) $('s-terrain_factor').value = data.terrain_factor ?? transportLocal.terrain_factor ?? 1.25;
  if ($('s-intercity_flat_fee')) $('s-intercity_flat_fee').value = data.intercity_flat_fee ?? transportLocal.intercity_flat_fee ?? 50;
  if ($('s-intercity_enabled')) $('s-intercity_enabled').checked = (data.intercity_enabled ?? transportLocal.intercity_enabled) !== false;

  if (data.base_fee === undefined) $('set-msg').textContent = '⚠️ Run database-update-4.sql in Supabase before saving the new delivery prices.';
  updateFeeExamples();
  initShopMap();
}

// What a customer would pay for some typical trips (same formula as the server)
function calcFee(km, minutes) {
  const v = (id) => Number($(id)?.value) || 0;
  const isChecked = (id) => $(id)?.checked ?? true;

  const base = v('s-base_fee') || 10;
  const minFee = v('s-min_fee') || 20;
  const perKm = v('s-per_km') || 1.5;
  const perMin = v('s-per_minute') || 0.3;
  const longThreshold = v('s-long_km_threshold') || 35;
  const longPerKm = Math.max(v('s-long_per_km') || 0.8, 0.4);
  const terrainFactor = Math.max(v('s-terrain_factor') || 1.25, 1.0);
  const intercityFee = v('s-intercity_flat_fee') || 50;
  const intercityEnabled = isChecked('s-intercity_enabled');
  const step = v('s-round_to') > 0 ? v('s-round_to') : 1;

  // Intercity trips (> 35 km, e.g. Kumasi to Accra, Takoradi, Sunyani, Tamale):
  // Dispatched via VIP / STC bus terminal with flat parcel rate
  if (intercityEnabled && km > 35) {
    let fee = intercityFee;
    if (km > 100) {
      fee += Math.ceil((km - 100) / 50) * 5; // +5 GHS per 50 km past 100 km
    }
    return Math.ceil(fee / step) * step;
  }

  // Local & Metropolitan trips:
  // Apply terrain / untarred road / traffic buffer factor to travel minutes internally
  const bufferedMinutes = minutes * terrainFactor;

  // Strictly monotonic tiered pricing (longer distance is guaranteed to be >= shorter distance)
  const near = Math.min(km, longThreshold);
  const far = Math.max(km - longThreshold, 0);
  let fee = base + (near * perKm) + (far * longPerKm) + (bufferedMinutes * perMin);
  fee = Math.max(fee, minFee);

  return Math.ceil(fee / step) * step;
}

function updateFeeExamples() {
  const trips = [
    [2, 8, 'Nearby, 2 km (8 min)'],
    [8, 20, 'Across town, 8 km (20 min)'],
    [25, 40, 'Outskirts, 25 km (40 min)'],
    [90, 120, 'Another region, 90 km (2 h - STC/VIP Bus parcel)'],
    [260, 270, 'Kumasi to Accra, 260 km (4 h 30 - STC/VIP Bus parcel)']
  ];
  $('fee-examples').innerHTML = '<table class="fee-table"><tr><th>Example trip</th><th>Customer pays</th></tr>' +
    trips.map(([km, m, t]) => `<tr><td>${t}</td><td><b>GHS ${calcFee(km, m)}</b></td></tr>`).join('') + '</table>' +
    '<p class="img-hint">Calculated with your road/terrain buffer and bus parcel rates. Adjust the numbers above to set fair prices.</p>';
  $('map-check').href = `https://www.google.com/maps?q=${$('s-shop_lat').value},${$('s-shop_lng').value}`;
}
['s-base_fee', 's-min_fee', 's-per_km', 's-per_minute', 's-long_km_threshold', 's-long_per_km', 's-round_to', 's-shop_lat', 's-shop_lng', 's-terrain_factor', 's-intercity_flat_fee']
  .forEach((id) => $(id)?.addEventListener('input', updateFeeExamples));
$('s-intercity_enabled')?.addEventListener('change', updateFeeExamples);

// ----- Shop location picker (search + tap the map) -----
let shopMap = null;
let shopMarker = null;

function setShopPin(lat, lng, recenter) {
  $('s-shop_lat').value = Number(lat).toFixed(6);
  $('s-shop_lng').value = Number(lng).toFixed(6);
  if (shopMap) {
    if (!shopMarker) shopMarker = L.circleMarker([lat, lng], { radius: 10, color: '#d4af37', fillColor: '#121212', fillOpacity: 1, weight: 3 }).addTo(shopMap);
    else shopMarker.setLatLng([lat, lng]);
    if (recenter) shopMap.setView([lat, lng], Math.max(shopMap.getZoom(), 16));
  }
  updateFeeExamples();
}

function initShopMap() {
  if (typeof L === 'undefined' || !$('shop-map')) return;
  const lat = parseFloat($('s-shop_lat').value) || 6.6966;
  const lng = parseFloat($('s-shop_lng').value) || -1.6225;
  if (!shopMap) {
    shopMap = L.map('shop-map').setView([lat, lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(shopMap);
    shopMap.on('click', (e) => { setShopPin(e.latlng.lat, e.latlng.lng, false); $('set-msg').textContent = 'Pin moved. Click Save Settings to keep it.'; });
  }
  setShopPin(lat, lng, true);
  setTimeout(() => shopMap.invalidateSize(), 150);
}

async function searchShopPlace() {
  const q = $('shop-search').value.trim();
  const list = $('shop-results');
  if (q.length < 2) return;

  // A Google Maps link or coordinates sets the pin directly
  if (parseCoords(q) || looksLikeMapLink(q)) {
    let point = parseCoords(q);
    if (!point) {
      $('set-msg').textContent = 'Reading the link...';
      try { point = (await callFn('checkout', { action: 'resolve_link', url: q })).location; }
      catch (err) { $('set-msg').textContent = '⚠️ ' + err.message; return; }
    }
    list.className = 'shop-results';
    setShopPin(point.lat, point.lng, true);
    $('set-msg').textContent = 'Pin set from the link. Check it is on the shop, then click Save Settings.';
    return;
  }

  list.className = 'shop-results show';
  list.innerHTML = '<li>Searching...</li>';
  try {
    const near = { lat: parseFloat($('s-shop_lat').value) || 6.6966, lng: parseFloat($('s-shop_lng').value) || -1.6225 };
    const results = await searchPlaces(q, near, 'Kumasi');
    if (!results.length) { list.innerHTML = '<li>Nothing found. Try a nearby landmark, paste a Google Maps link, or tap the map.</li>'; return; }
    list.innerHTML = '';
    results.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.addEventListener('click', () => {
        list.className = 'shop-results';
        if (!$('s-shop_address').value.trim() || $('s-shop_address').value === 'Kejetia Market, Kumasi') $('s-shop_address').value = p.name.split(',').slice(0, 3).join(',').trim();
        setShopPin(p.lat, p.lng, true);
        $('set-msg').textContent = 'Now tap the map right on your shop, then click Save Settings.';
      });
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = '<li>Search is not available right now. Please tap the map instead.</li>';
  }
}
$('shop-search-btn')?.addEventListener('click', searchShopPlace);
$('shop-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchShopPlace(); } });

$('s-locate')?.addEventListener('click', () => {
  if (!navigator.geolocation) return alert('This browser cannot read your location.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setShopPin(pos.coords.latitude, pos.coords.longitude, true);
      $('set-msg').textContent = `Location found (accuracy about ${Math.round(pos.coords.accuracy)} m). Check the pin is on the shop, then click Save Settings.`;
    },
    () => alert('Could not get your location. Allow location access and try again.'),
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

$('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = (id) => parseFloat($(id).value);
  const update = {
    shop_address: $('s-shop_address').value.trim() || 'Kejetia Market, Kumasi',
    shop_lat: num('s-shop_lat'),
    shop_lng: num('s-shop_lng'),
    base_fee: num('s-base_fee'),
    min_fee: num('s-min_fee'),
    per_km: num('s-per_km'),
    per_minute: num('s-per_minute'),
    long_km_threshold: num('s-long_km_threshold'),
    long_per_km: num('s-long_per_km'),
    round_to: num('s-round_to'),
    max_delivery_km: num('s-max_delivery_km'),
    traffic_factor: num('s-traffic_factor'),
    rush_factor: num('s-rush_factor'),
    pickup_enabled: $('s-pickup_enabled').checked,
    delivery_enabled: $('s-delivery_enabled').checked,
    online_payments_enabled: $('s-online_payments_enabled').checked,
    owner_whatsapp: $('s-owner_whatsapp').value.trim() || null,
    owner_phone: $('s-owner_phone').value.trim() || null,
    owner_email: $('s-owner_email').value.trim() || null,
    chat_forward_enabled: $('s-chat_forward_enabled').checked,
    chat_forward_minutes: parseInt($('s-chat_forward_minutes').value, 10),
    updated_at: new Date().toISOString()
  };
  if (Object.values(update).some((v) => typeof v === 'number' && Number.isNaN(v))) {
    $('set-msg').textContent = '⚠️ Please fill in every number field.';
    return;
  }
  for (const key of ['owner_whatsapp', 'owner_phone']) {
    if (update[key] && !isValidGhPhone(update[key])) {
      $('set-msg').textContent = '⚠️ Phone numbers must be 10 digits starting with 0.';
      return;
    }
  }
  if (!update.pickup_enabled && !update.delivery_enabled) {
    $('set-msg').textContent = '⚠️ Turn on pickup, delivery, or both.';
    return;
  }
  const transportSettings = {
    terrain_factor: parseFloat($('s-terrain_factor')?.value) || 1.25,
    intercity_flat_fee: parseFloat($('s-intercity_flat_fee')?.value) || 50,
    intercity_enabled: $('s-intercity_enabled')?.checked ?? true
  };
  try { localStorage.setItem('kd_transport_settings', JSON.stringify(transportSettings)); } catch(e) {}

  let updateWithCustom = { ...update, ...transportSettings };
  let { error } = await supabase.from('store_settings').update(updateWithCustom).eq('id', 1);
  if (error && error.message && error.message.includes('column')) {
    const res = await supabase.from('store_settings').update(update).eq('id', 1);
    error = res.error;
  }
  $('set-msg').textContent = error ? '⚠️ ' + error.message : '✅ Settings saved successfully.';
  if (!error) settings = { ...settings, ...update, ...transportSettings };
});

$('test-notify')?.addEventListener('click', async () => {
  $('set-msg').textContent = 'Sending test...';
  try {
    const res = await callFn('admin-actions', { action: 'test_notifications' });
    const r = res.results || {};
    const part = (k, label) => (k in r ? `${label}: ${r[k] ? 'sent ✅' : 'failed ⚠️'}` : '');
    $('set-msg').textContent = [part('whatsapp', 'WhatsApp'), part('sms', 'SMS'), part('email', 'Email')].filter(Boolean).join(' · ') ||
      'Nothing was sent. Add your WhatsApp number / phone / email above and the service keys in Supabase.';
  } catch (err) {
    $('set-msg').textContent = '⚠️ ' + err.message;
  }
});

// ---------------- Start / stop with the admin login ----------------
async function start() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { stop(); return; }
  const { data } = await supabase.rpc('is_admin');
  isAdmin = data === true;
  if (!isAdmin) { stop(); return; }

  const { data: st } = await supabase.from('store_settings').select('*').eq('id', 1).maybeSingle();
  settings = st || null;
  await loadOrders();

  if (!channel) {
    channel = supabase
      .channel('admin-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        loadOrders();
        if (!$('tab-customers').hidden) renderCustomers();
      })
      .subscribe();
  }
}

function stop() {
  isAdmin = false;
  orders = [];
  if (channel) { supabase.removeChannel(channel); channel = null; }
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(start, 300);
  if (event === 'SIGNED_OUT') { stop(); showTab('inventory'); }
});

initPhoneInputs();
