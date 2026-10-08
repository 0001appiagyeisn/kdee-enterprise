// Admin: Orders, Customers and Settings tabs (works alongside admin.js, which handles login + inventory)
import { supabase } from './supabase-config.js';
import { initPhoneInputs, setPhone, isValidGhPhone } from './phone-input.js';
import { searchPlaces, parseCoords, looksLikeMapLink, distanceKm } from './place-search.js';

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
  if (name === 'transport') loadTransportTab();
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

  // Load custom terrain, corridor and intercity parcel settings (from db if columns exist, or localStorage)
  let transportLocal = {};
  try { transportLocal = JSON.parse(localStorage.getItem('kd_transport_settings') || '{}'); } catch(e) {}
  if ($('s-terrain_factor')) $('s-terrain_factor').value = data.terrain_factor ?? transportLocal.terrain_factor ?? 1.25;
  if ($('s-intercity_flat_fee')) $('s-intercity_flat_fee').value = data.intercity_flat_fee ?? transportLocal.intercity_flat_fee ?? 50;
  if ($('s-intercity_per_km')) $('s-intercity_per_km').value = data.intercity_per_km ?? transportLocal.intercity_per_km ?? 0.38;
  if ($('s-accra_flat_fee')) $('s-accra_flat_fee').value = data.accra_flat_fee ?? transportLocal.accra_flat_fee ?? 120;
  if ($('s-rough_road_per_km')) $('s-rough_road_per_km').value = data.rough_road_per_km ?? transportLocal.rough_road_per_km ?? 1.23;
  if ($('s-intercity_enabled')) $('s-intercity_enabled').checked = (data.intercity_enabled ?? transportLocal.intercity_enabled) !== false;

  if (data.base_fee === undefined) $('set-msg').textContent = '⚠️ Run database-update-4.sql in Supabase before saving the new delivery prices.';
  updateFeeExamples();
  initShopMap();
}

function detectCorridor(lat, lng, address) {
  const addr = String(address || '').toLowerCase();
  // 1. Greater Accra Highway Corridor (Accra, Tema, Kasoa, etc.)
  if (
    (typeof lat === 'number' && lat >= 5.40 && lat <= 6.00 && typeof lng === 'number' && lng >= -0.65 && lng <= 0.20) ||
    /accra|tema|kasoa|madina|adenta|spintex|dansoman|kaneshie|circle|legon|ashaiman/.test(addr)
  ) {
    return 'accra';
  }
  // 2. Wassa & Western Rough/Untarred Road Corridor (Gyapa, Wassa Akropong, Amenfi, Bogoso, Prestea, Tarkwa, etc.)
  if (
    (typeof lat === 'number' && lat >= 5.10 && lat <= 6.45 && typeof lng === 'number' && lng >= -2.90 && lng <= -1.80) ||
    /wassa|gyapa|akropong|amenfi|bogoso|prestea|tarkwa|asankragwa|manso|enchi|dadieso|sefwi|juaboso|bia|western/.test(addr)
  ) {
    return 'rough_road';
  }
  // 3. Standard intercity corridor
  return 'standard_intercity';
}

// What a customer would pay for some typical trips (same formula as the client checkout)
function calcFee(km, minutes, lat, lng, address) {
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
  const intercityPerKm = Math.max(v('s-intercity_per_km') || 0.38, 0.1);
  const accraFlatFee = v('s-accra_flat_fee') || 120;
  const roughRoadPerKm = Math.max(v('s-rough_road_per_km') || 1.22, 0.5);
  const intercityEnabled = isChecked('s-intercity_enabled');
  const step = v('s-round_to') > 0 ? v('s-round_to') : 1;

  // Check if destination matches any Saved Town Checkpoint (exact admin override)
  const matchedCp = matchCheckpoint(lat, lng, address);
  if (matchedCp) {
    return matchedCp.fare;
  }

  // Intercity trips (> 35 km, e.g. Kumasi to Accra, Takoradi, Sunyani, Wassa, Tamale)
  if (intercityEnabled && km > 35) {
    const corridor = detectCorridor(lat, lng, address);
    if (corridor === 'accra') {
      return Math.ceil(accraFlatFee / step) * step;
    }
    if (corridor === 'rough_road') {
      const fee = km * roughRoadPerKm;
      return Math.ceil(fee / step) * step;
    }
    // Standard Intercity (VIP/STC bus to other regions)
    const fee = intercityFee + ((km - 35) * intercityPerKm);
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
    [2, 8, 'Nearby (Adum), 2 km (8 min)', null, null, 'Adum, Kumasi'],
    [8, 20, 'Across town (KNUST), 8 km (20 min)', null, null, 'KNUST, Kumasi'],
    [25, 40, 'Outskirts (Ejisu), 25 km (40 min)', null, null, 'Ejisu'],
    [188.66, 290, 'Standard Intercity, 188.7 km (~4 h 50 min)', 6.2, -0.6, 'Eastern Region'],
    [260, 270, 'Greater Accra (VIP/STC Highway), 260 km', 5.6, -0.2, 'Accra, Greater Accra'],
    [121.5, 230, 'Gyapa at Wassa (Rough Road Corridor), 121.5 km', 5.85, -2.15, 'Gyapa, Wassa'],
    [137.89, 260, 'Wassa Akropong (Rough Road Corridor), 137.9 km', 5.78, -2.09, 'Wassa Akropong, Western']
  ];
  $('fee-examples').innerHTML = '<table class="fee-table"><tr><th>Example trip</th><th>Customer pays</th></tr>' +
    trips.map(([km, m, t, lat, lng, addr]) => `<tr><td>${t}</td><td><b>GHS ${calcFee(km, m, lat, lng, addr)}</b></td></tr>`).join('') + '</table>' +
    '<p class="img-hint">Calculated with your road/terrain settings, corridor caps and parcel rates. Adjust the numbers above to set fair prices.</p>';
  $('map-check').href = `https://www.google.com/maps?q=${$('s-shop_lat').value},${$('s-shop_lng').value}`;
}
['s-base_fee', 's-min_fee', 's-per_km', 's-per_minute', 's-long_km_threshold', 's-long_per_km', 's-round_to', 's-shop_lat', 's-shop_lng', 's-terrain_factor', 's-intercity_flat_fee', 's-intercity_per_km', 's-accra_flat_fee', 's-rough_road_per_km']
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
    intercity_per_km: parseFloat($('s-intercity_per_km')?.value) || 0.38,
    accra_flat_fee: parseFloat($('s-accra_flat_fee')?.value) || 120,
    rough_road_per_km: parseFloat($('s-rough_road_per_km')?.value) || 1.23,
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

// ==================== Dedicated Transport & Checkpoint Calibrator ====================
const DEFAULT_CHECKPOINTS = [
  { id: 'cp-accra', name: 'Greater Accra (Circle, Kaneshie, Tema, Madina)', lat: 5.6037, lng: -0.1870, radius_km: 30, fare: 120, corridor: 'Accra Highway VIP', keywords: ['accra', 'tema', 'kasoa', 'madina', 'adenta', 'spintex', 'dansoman', 'kaneshie', 'circle', 'legon'] },
  { id: 'cp-gyapa', name: 'Gyapa at Wassa (Amenfi)', lat: 5.8500, lng: -2.1500, radius_km: 15, fare: 150, corridor: 'Rough Road Corridor', keywords: ['gyapa', 'wassa', 'amenfi'] },
  { id: 'cp-akropong', name: 'Wassa Akropong', lat: 5.7833, lng: -2.0833, radius_km: 15, fare: 170, corridor: 'Rough Road Corridor', keywords: ['akropong', 'wassa akropong'] },
  { id: 'cp-takoradi', name: 'Takoradi (Market Circle)', lat: 4.8986, lng: -1.7583, radius_km: 20, fare: 110, corridor: 'Intercity Bus', keywords: ['takoradi', 'sekondi'] },
  { id: 'cp-sunyani', name: 'Sunyani (Main Station)', lat: 7.3400, lng: -2.3200, radius_km: 20, fare: 85, corridor: 'Intercity Bus', keywords: ['sunyani'] },
  { id: 'cp-tamale', name: 'Tamale (Central Station)', lat: 9.4008, lng: -0.8393, radius_km: 25, fare: 180, corridor: 'Northern Intercity Bus', keywords: ['tamale'] },
  { id: 'cp-capecoast', name: 'Cape Coast', lat: 5.1054, lng: -1.2466, radius_km: 20, fare: 100, corridor: 'Intercity Bus', keywords: ['cape coast', 'elmina'] }
];

function getSavedCheckpoints() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem('kd_saved_checkpoints') || '[]'); } catch(e) {}
  if (!Array.isArray(list) || list.length === 0) {
    list = [...DEFAULT_CHECKPOINTS];
    try { localStorage.setItem('kd_saved_checkpoints', JSON.stringify(list)); } catch(e) {}
  }
  return list;
}

function saveCheckpoints(list) {
  try { localStorage.setItem('kd_saved_checkpoints', JSON.stringify(list)); } catch(e) {}
  renderCheckpointsTable();
}

function matchCheckpoint(lat, lng, address) {
  const list = getSavedCheckpoints();
  const addr = String(address || '').toLowerCase();
  for (const cp of list) {
    if (typeof lat === 'number' && typeof lng === 'number' && cp.lat && cp.lng) {
      const d = distanceKm({ lat, lng }, { lat: cp.lat, lng: cp.lng }) * 1.35;
      if (d <= (cp.radius_km || 15)) return cp;
    }
    if (addr && Array.isArray(cp.keywords) && cp.keywords.some((k) => addr.includes(k))) {
      return cp;
    }
  }
  return null;
}

function renderCheckpointsTable() {
  const list = getSavedCheckpoints();
  const tbody = $('cp-list-body');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:14px;">No saved checkpoints yet. Use the simulator above to add towns.</td></tr>';
    return;
  }
  const shopLat = parseFloat($('s-shop_lat')?.value) || 6.6966;
  const shopLng = parseFloat($('s-shop_lng')?.value) || -1.6225;

  tbody.innerHTML = list.map((cp, idx) => {
    const d = (distanceKm({ lat: shopLat, lng: shopLng }, { lat: cp.lat, lng: cp.lng }) * 1.35).toFixed(1);
    const isRough = String(cp.corridor || '').includes('Rough');
    return `
      <tr>
        <td><b>${escapeHtml(cp.name)}</b></td>
        <td>${d} km</td>
        <td><span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:700;background:${isRough ? '#fdeceb;color:#a12d27' : '#e9f7ee;color:#1e6b34'};">${escapeHtml(cp.corridor || 'Custom')}</span></td>
        <td>${cp.radius_km || 15} km</td>
        <td><b style="color:var(--primary);font-size:1.05rem;">GHS ${Number(cp.fare).toFixed(2)}</b></td>
        <td style="text-align:right;">
          <button type="button" class="btn-action btn-edit btn-sm btn-cp-test" data-idx="${idx}" title="Test on Map"><i class="fa-solid fa-map-pin"></i> Test</button>
          <button type="button" class="btn-action btn-save btn-sm btn-cp-edit" data-idx="${idx}" title="Edit Fare"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn-action btn-delete btn-sm btn-cp-del" data-idx="${idx}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-cp-test').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cp = list[btn.dataset.idx];
      if (cp) testCheckpointOnMap(cp);
    });
  });
  tbody.querySelectorAll('.btn-cp-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cp = list[btn.dataset.idx];
      if (!cp) return;
      const newFare = prompt(`Enter new accepted fare for ${cp.name} (GHS):`, cp.fare);
      if (newFare !== null && !isNaN(parseFloat(newFare)) && parseFloat(newFare) > 0) {
        cp.fare = Math.round(parseFloat(newFare));
        saveCheckpoints(list);
        updateFeeExamples();
      }
    });
  });
  tbody.querySelectorAll('.btn-cp-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cp = list[btn.dataset.idx];
      if (confirm(`Remove checkpoint for "${cp.name}"?`)) {
        list.splice(btn.dataset.idx, 1);
        saveCheckpoints(list);
        updateFeeExamples();
      }
    });
  });
}

let simMap = null;
let simMarkerShop = null;
let simMarkerDest = null;
let simRouteLine = null;
let simCurrentDest = null;

function initSimulatorMap() {
  const shopLat = parseFloat($('s-shop_lat')?.value) || 6.6966;
  const shopLng = parseFloat($('s-shop_lng')?.value) || -1.6225;

  if (!simMap && $('sim-map')) {
    simMap = L.map('sim-map').setView([shopLat, shopLng], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(simMap);

    const shopIcon = L.divIcon({
      html: '<div style="background:#111;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);"><i class="fa-solid fa-store" style="font-size:14px;"></i></div>',
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
    simMarkerShop = L.marker([shopLat, shopLng], { icon: shopIcon }).addTo(simMap);
    simMarkerShop.bindTooltip('Point A: KD Wisdom Shop (Kejetia Market)').openTooltip();

    simMap.on('click', async (e) => {
      let placeName = 'Selected Map Pin';
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
        const d = await r.json();
        if (d && d.display_name) placeName = d.display_name.split(',').slice(0, 3).join(', ').trim();
      } catch(err) {}
      runRouteSimulation(e.latlng.lat, e.latlng.lng, placeName);
    });
  }
  setTimeout(() => { if (simMap) simMap.invalidateSize(); }, 200);
}

function runRouteSimulation(lat, lng, name) {
  if (!simMap) initSimulatorMap();
  const shopLat = parseFloat($('s-shop_lat')?.value) || 6.6966;
  const shopLng = parseFloat($('s-shop_lng')?.value) || -1.6225;

  const rawKm = distanceKm({ lat: shopLat, lng: shopLng }, { lat, lng }) * 1.35;
  const km = Math.max(parseFloat(rawKm.toFixed(1)), 1);
  const speedKmH = km > 35 ? 55 : (km > 15 ? 35 : 25);
  const minutes = Math.max(Math.round((km / speedKmH) * 60), 10);
  const hrs = Math.floor(minutes / 60), mins = minutes % 60;
  const timeStr = hrs ? `${hrs} h ${mins} min` : `${mins} min`;

  const corridorKey = detectCorridor(lat, lng, name);
  let corridorLabel = 'Standard Intercity';
  if (corridorKey === 'accra') corridorLabel = 'Greater Accra Highway (VIP/STC)';
  else if (corridorKey === 'rough_road') corridorLabel = 'Rough Road Terrain (Wassa)';
  else if (km <= 35) corridorLabel = 'Kumasi Local Dispatch';

  const existingCp = matchCheckpoint(lat, lng, name);
  let calcPresetFare = 0;
  if (existingCp) {
    calcPresetFare = existingCp.fare;
    corridorLabel += ` [Active Checkpoint: ${existingCp.name}]`;
  } else {
    calcPresetFare = calcFee(km, minutes, lat, lng, name);
  }

  simCurrentDest = { lat, lng, name, km, minutes, fare: calcPresetFare, corridor: corridorLabel };

  if (simMarkerDest) simMap.removeLayer(simMarkerDest);
  const destIcon = L.divIcon({
    html: '<div style="background:#e74c3c;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);"><i class="fa-solid fa-location-dot" style="font-size:16px;"></i></div>',
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
  simMarkerDest = L.marker([lat, lng], { icon: destIcon }).addTo(simMap);
  simMarkerDest.bindTooltip(`Point B: ${name} (${km} km)`).openTooltip();

  if (simRouteLine) simMap.removeLayer(simRouteLine);
  simRouteLine = L.polyline([[shopLat, shopLng], [lat, lng]], { color: '#e67e22', weight: 4, dashArray: '6, 8' }).addTo(simMap);
  simMap.fitBounds(L.latLngBounds([[shopLat, shopLng], [lat, lng]]), { padding: [50, 50] });

  $('sim-stat-km').textContent = `${km} km`;
  $('sim-stat-time').textContent = timeStr;
  $('sim-stat-corridor').textContent = corridorLabel;
  $('sim-stat-preset').textContent = `GHS ${Number(calcPresetFare).toFixed(2)}`;

  $('sim-cp-name').value = name || 'Custom Area';
  $('sim-cp-fare').value = existingCp ? existingCp.fare : calcPresetFare;
  $('sim-cp-feedback').textContent = existingCp
    ? `📍 Matches active checkpoint "${existingCp.name}". You can update the fare below.`
    : `Calculated from preset formulas. If actual station fare is different, improvise above and save.`;
}

function testCheckpointOnMap(cp) {
  runRouteSimulation(cp.lat, cp.lng, cp.name);
  if ($('sim-map')) {
    window.scrollTo({ top: $('sim-map').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
  }
}

async function loadTransportTab() {
  if (!settings) await loadSettings();
  renderCheckpointsTable();
  initSimulatorMap();
}

// Checkpoint and Simulator event listeners
$('btn-save-checkpoint')?.addEventListener('click', () => {
  if (!simCurrentDest) return alert('Please select a destination on the map or click a quick town chip first.');
  const name = $('sim-cp-name').value.trim();
  const fare = parseFloat($('sim-cp-fare').value);
  const radius = parseFloat($('sim-cp-radius')?.value) || 15;
  if (!name) return alert('Please enter a town or checkpoint name.');
  if (isNaN(fare) || fare <= 0) return alert('Please enter a valid fare in GHS.');

  const list = getSavedCheckpoints();
  const existingIdx = list.findIndex((c) => c.name.toLowerCase() === name.toLowerCase() || (Math.abs(c.lat - simCurrentDest.lat) < 0.05 && Math.abs(c.lng - simCurrentDest.lng) < 0.05));
  const newCp = {
    id: 'cp-' + Date.now(),
    name,
    lat: simCurrentDest.lat,
    lng: simCurrentDest.lng,
    radius_km: radius,
    fare: Math.round(fare),
    corridor: simCurrentDest.corridor,
    keywords: [name.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()]
  };

  if (existingIdx > -1) {
    list[existingIdx] = { ...list[existingIdx], ...newCp, id: list[existingIdx].id };
  } else {
    list.unshift(newCp);
  }
  saveCheckpoints(list);
  updateFeeExamples();
  $('sim-cp-feedback').textContent = `✅ Checkpoint saved! Deliveries to "${name}" will now automatically quote GHS ${fare.toFixed(2)}.`;
});

$('btn-reset-checkpoints')?.addEventListener('click', () => {
  if (confirm('Restore the default Ghana checkpoints (Accra, Gyapa, Wassa Akropong, Takoradi, Sunyani, Tamale, Cape Coast)?')) {
    saveCheckpoints([...DEFAULT_CHECKPOINTS]);
    updateFeeExamples();
    alert('Default checkpoints restored.');
  }
});

document.querySelectorAll('#sim-quick-chips .color-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const lat = parseFloat(chip.dataset.lat);
    const lng = parseFloat(chip.dataset.lng);
    const name = chip.dataset.name;
    runRouteSimulation(lat, lng, name);
  });
});

async function searchSimDest() {
  const q = $('sim-dest-search').value.trim();
  const list = $('sim-dest-results');
  if (q.length < 2) return;
  list.className = 'shop-results show';
  list.innerHTML = '<li>Searching towns in Ghana...</li>';
  try {
    const near = { lat: parseFloat($('s-shop_lat')?.value) || 6.6966, lng: parseFloat($('s-shop_lng')?.value) || -1.6225 };
    const results = await searchPlaces(q, near, 'Ghana');
    if (!results.length) { list.innerHTML = '<li>No place found. Try another town name or tap the map.</li>'; return; }
    list.innerHTML = '';
    results.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.addEventListener('click', () => {
        list.className = 'shop-results';
        $('sim-dest-search').value = p.name.split(',').slice(0, 2).join(', ').trim();
        runRouteSimulation(p.lat, p.lng, p.name.split(',')[0].trim());
      });
      list.appendChild(li);
    });
  } catch(e) {
    list.innerHTML = '<li>Search failed. Please tap the map instead.</li>';
  }
}
$('sim-dest-btn')?.addEventListener('click', searchSimDest);
$('sim-dest-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchSimDest(); } });
