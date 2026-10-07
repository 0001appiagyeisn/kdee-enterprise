import { supabase } from './supabase-config.js';
import { cartKey } from './cart-store.js';

let uid = null;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Paystack adds ?reference=...&trxref=... when it sends the customer back
const reference = params.get('reference') || params.get('trxref') || '';

const STATUS_LABELS = {
  pending_payment: 'Awaiting payment', paid: 'Paid', processing: 'Being prepared', ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded'
};
const money = (n) => 'GHS ' + Number(n || 0).toFixed(2);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

async function check() {
  const { data, error } = await supabase.functions.invoke('paystack-verify', { body: { reference } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}

function showMessage(icon, title, text, color) {
  $('loading-box').hidden = true;
  const box = $('receipt');
  box.hidden = false;
  box.innerHTML = `
    <div class="receipt-head">
      <div class="icon" style="color:${color}"><i class="fa-solid ${icon}"></i></div>
      <h1 style="font-size:1.5rem;">${title}</h1>
      <p class="muted">${text}</p>
    </div>
    <div style="text-align:center;" class="no-print">
      <a href="account.html" class="btn btn-dark">My Orders</a>
      <a href="index.html" class="btn btn-outline">Back to Shop</a>
    </div>`;
}

// ---------- Order tracking ----------
const RANK = { paid: 0, processing: 1, ready_for_pickup: 2, out_for_delivery: 2, delivered: 3, completed: 3 };
function trackingHtml(o) {
  if (o.status === 'cancelled' || o.status === 'refunded') {
    return `<div class="track"><b>${o.status === 'refunded' ? 'This order was refunded.' : 'This order was cancelled.'}</b>
      <p class="muted">Contact us if you have any questions.</p></div>`;
  }
  const steps = o.delivery_method === 'delivery'
    ? [['paid', 'Payment received'], ['processing', 'Preparing your order'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered']]
    : [['paid', 'Payment received'], ['processing', 'Preparing your order'], ['ready_for_pickup', 'Ready for pickup at our shop'], ['completed', 'Picked up']];
  const reached = RANK[o.status] ?? -1;
  const history = Array.isArray(o.status_history) ? o.status_history : [];
  const when = (status, i) => {
    const hit = history.find((h) => h.status === status) || (i === 3 ? history.find((h) => h.status === 'delivered' || h.status === 'completed') : null);
    if (hit) return fmtDate(hit.at);
    if (status === 'paid' && o.paid_at) return fmtDate(o.paid_at);
    return '';
  };
  return `<div class="track"><h3><i class="fa-solid fa-route"></i> Order progress</h3>` + steps.map(([status, label], i) => `
    <div class="track-step ${i <= reached ? 'done' : ''} ${i === reached + 1 ? 'current' : ''}">
      <div class="track-dot">${i <= reached ? '<i class="fa-solid fa-check"></i>' : i + 1}</div>
      <div><b>${label}</b><small>${i <= reached ? when(status, i) : (i === reached + 1 ? 'Next step' : '')}</small></div>
    </div>`).join('') +
    '<p class="muted" style="margin-top:10px;">This page updates by itself. We also send you an SMS at each step.</p></div>';
}

// Logged-in buyers get the full order (with progress times) straight from the database
async function fullOrder(o) {
  if (!uid) return o;
  const { data } = await supabase.from('orders').select('*').eq('payment_reference', reference).maybeSingle();
  return data || o;
}

let watching = false;
function watchOrder() {
  if (watching || !uid) return;
  watching = true;
  supabase.channel('track-' + reference)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `payment_reference=eq.${reference}` },
      (payload) => showReceipt(payload.new))
    .subscribe();
}

function showReceipt(o) {
  // Paid, so the cart can be emptied
  localStorage.removeItem(cartKey('retail', uid));
  if (o.order_type === 'wholesale') localStorage.removeItem('kd_ws_sizes');

  $('loading-box').hidden = true;
  const box = $('receipt');
  box.hidden = false;
  const rows = (o.items || []).map((it) => `
    <tr>
      <td>${escapeHtml(it.name)}${it.size ? ` <small class="muted">(Size ${escapeHtml(it.size)}${it.color ? ' · ' + escapeHtml(it.color) : ''})</small>` : (it.color ? ` <small class="muted">(${escapeHtml(it.color)})</small>` : '')}</td>
      <td class="r">${it.qty}</td>
      <td class="r">${money(it.unit_price)}</td>
      <td class="r">${money(it.line_total)}</td>
    </tr>`).join('');
  const delivery = o.delivery_method === 'delivery'
    ? `Delivery to ${escapeHtml(o.delivery_address || '')}${o.delivery_km ? ` (${o.delivery_km} km)` : ''}`
    : 'Pickup at our shop — Kejetia Market, Kumasi';
  const refunded = o.status === 'refunded';

  box.innerHTML = `
    <div class="receipt-head">
      <div class="icon" style="color:${refunded ? '#a12d27' : 'var(--success)'}"><i class="fa-solid ${refunded ? 'fa-rotate-left' : 'fa-circle-check'}"></i></div>
      <h1 style="font-size:1.5rem;">${refunded ? 'Order refunded' : (o.status === 'paid' ? 'Thank you! Payment received.' : 'Track your order')}</h1>
      <p class="muted">${refunded ? `Refund of ${money(o.refund_amount)} started.` : 'A receipt was sent to your email and phone.'}</p>
    </div>
    ${trackingHtml(o)}
    <div class="meta">
      <div><b>Order number</b><br>${escapeHtml(o.order_number)}</div>
      <div><b>Status</b><br><span class="badge ${o.status}">${STATUS_LABELS[o.status] || o.status}</span></div>
      <div><b>Paid on</b><br>${fmtDate(o.paid_at)}</div>
      <div><b>Payment</b><br>${escapeHtml((o.payment_channel || o.payment_method || '').replace(/_/g, ' '))}</div>
      <div><b>Customer</b><br>${escapeHtml(o.customer_name)}<br>${escapeHtml(o.customer_phone)}</div>
      <div><b>${o.delivery_method === 'delivery' ? 'Delivery' : 'Pickup'}</b><br>${delivery}</div>
    </div>
    <table>
      <tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>
      ${rows}
      <tr><td colspan="3">Subtotal</td><td class="r">${money(o.subtotal)}</td></tr>
      <tr><td colspan="3">Delivery</td><td class="r">${money(o.delivery_fee)}</td></tr>
      <tr><td colspan="3"><b>Total paid</b></td><td class="r"><b style="color:var(--accent-hover)">${money(o.total)}</b></td></tr>
    </table>
    ${o.notes ? `<p class="muted"><b>Notes:</b> ${escapeHtml(o.notes)}</p>` : ''}
    <p class="muted" style="margin-top:10px;">Reference: ${escapeHtml(o.payment_reference || '')} · <a href="refund-policy.html" style="text-decoration:underline;">Refund policy</a></p>
    <div style="text-align:center;margin-top:22px;" class="no-print">
      <button class="btn btn-dark" id="print-btn"><i class="fa-solid fa-print"></i> Print / Save Receipt</button>
      <a href="index.html" class="btn btn-outline">Continue Shopping</a>
    </div>`;
  $('print-btn').addEventListener('click', () => window.print());
}

async function start() {
  const { data: { session } } = await supabase.auth.getSession();
  uid = session?.user?.id || null;
  if (!reference) {
    showMessage('fa-circle-question', 'No order selected', 'Open your orders from your account to see receipts.', '#888');
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 2 * 60 * 1000) {
    try {
      const r = await check();
      const o = r.order;
      if (o && o.status !== 'pending_payment' && o.status !== 'cancelled') { showReceipt(await fullOrder(o)); watchOrder(); return; }
      if (o && o.status === 'cancelled' && !o.paid_at) {
        return showMessage('fa-circle-xmark', 'Order cancelled', 'This order was not paid. Your cart is still saved — you can try again.', '#a12d27');
      }
      if (r.payment_status === 'failed' || r.payment_status === 'abandoned') {
        return showMessage('fa-circle-xmark', 'Payment not completed', (r.message ? escapeHtml(r.message) + '. ' : '') + 'You were not charged. Your cart is still saved — please try again.', '#a12d27');
      }
      $('loading-text').textContent = 'Still waiting for confirmation from your bank or mobile money provider...';
    } catch (err) {
      $('loading-text').textContent = err.message;
    }
    await sleep(5000);
  }
  showMessage('fa-clock', 'Payment not confirmed yet', "If you were charged, your order will update shortly — check My Orders. If not, your cart is still saved so you can try again.", '#b59226');
}

start();
