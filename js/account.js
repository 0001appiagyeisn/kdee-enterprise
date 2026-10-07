import { supabase } from './supabase-config.js';
import { initPhoneInputs, setPhone, isValidGhPhone } from './phone-input.js';

const $ = (id) => document.getElementById(id);
const NETWORKS = { mtn: 'MTN MoMo', vod: 'Telecel Cash', atl: 'AirtelTigo Money' };
const STATUS_LABELS = {
  pending_payment: 'Awaiting payment', paid: 'Paid', processing: 'Processing', ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded'
};

let currentUser = null;
let profile = null;
let recovering = false;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validPhone = isValidGhPhone;
const localPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('233')) d = '0' + d.slice(3); if (d.length === 9) d = '0' + d; return d; };

function showAlert(id, text, type = 'error') {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'alert' + (text ? ` show ${type}` : '');
}

function showView(name) {
  ['auth-view', 'reset-view', 'profile-view'].forEach((v) => { $(v).hidden = v !== `${name}-view`; });
}

// Only allow redirects to our own pages, e.g. ?next=checkout.html
function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return /^[a-z0-9_-]+\.html([?#][^\s]*)?$/i.test(next) ? next : null;
}

// ---------- Tabs ----------
function showPanel(name) {
  document.querySelectorAll('[data-panel]').forEach((f) => { f.hidden = f.dataset.panel !== name; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  showAlert('auth-alert', '');
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.tab)));
$('show-forgot').addEventListener('click', () => showPanel('forgot'));
$('back-login').addEventListener('click', () => showPanel('login'));

// ---------- Log in ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter; if (btn) btn.disabled = true;
  const { error } = await supabase.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value
  });
  if (btn) btn.disabled = false;
  if (error) {
    const msg = /confirm/i.test(error.message) ? 'Please confirm your email first (check your inbox), then log in.' : 'Wrong email or password.';
    return showAlert('auth-alert', msg);
  }
  const next = nextPage();
  if (next) location.href = next;
  else init();
});

// ---------- Password Visibility Toggle & Validation Helpers ----------
function initPasswordToggles() {
  document.querySelectorAll('.btn-pw-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const wrap = btn.closest('.input-password-wrap');
      const input = wrap ? wrap.querySelector('input') : null;
      if (!input) return;
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      const icon = btn.querySelector('i');
      if (icon) icon.className = isPw ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    });
  });
}

function testPassword(pw, confirm = '') {
  return {
    len: pw.length >= 8,
    case: /[a-z]/.test(pw) && /[A-Z]/.test(pw),
    num: /\d/.test(pw),
    sym: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw),
    match: confirm.length > 0 && pw === confirm
  };
}

function updateChecklist(prefix, checks) {
  const map = {
    len: `${prefix}-rule-len`,
    case: `${prefix}-rule-case`,
    num: `${prefix}-rule-num`,
    sym: `${prefix}-rule-sym`,
    match: `${prefix}-rule-match`
  };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const ok = Boolean(checks[key]);
    el.classList.toggle('valid', ok);
    const icon = el.querySelector('i');
    if (icon) icon.className = ok ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
  }
}

function bindPasswordChecklist(pwId, confirmId, prefix) {
  const pwEl = $(pwId);
  const confEl = $(confirmId);
  if (!pwEl) return;
  const run = () => {
    const pw = pwEl.value;
    const conf = confEl ? confEl.value : '';
    const checks = testPassword(pw, conf);
    updateChecklist(prefix, checks);
  };
  pwEl.addEventListener('input', run);
  if (confEl) confEl.addEventListener('input', run);
}

function getPasswordValidationError(pw, confirm) {
  const c = testPassword(pw, confirm);
  if (!c.len) return 'Password must be at least 8 characters.';
  if (!c.case) return 'Password must contain both uppercase and lowercase letters.';
  if (!c.num) return 'Password must contain at least one number (0-9).';
  if (!c.sym) return 'Password must contain at least one special symbol (!@#$%...).';
  if (!c.match) return 'The two passwords do not match.';
  return null;
}

// ---------- Sign up ----------
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('su-name').value.trim();
  const email = $('su-email').value.trim();
  const phone = $('su-phone').value.trim();
  const pw = $('su-password').value;
  const pw2 = $('su-password2').value;
  if (!validPhone(phone)) return showAlert('auth-alert', 'Please enter a valid 10-digit phone number starting with 0.');

  const pwErr = getPasswordValidationError(pw, pw2);
  if (pwErr) return showAlert('auth-alert', pwErr);

  const btn = e.submitter; if (btn) btn.disabled = true;
  const { data, error } = await supabase.auth.signUp({
    email,
    password: pw,
    options: { data: { full_name: name, phone }, emailRedirectTo: location.origin + location.pathname }
  });
  if (btn) btn.disabled = false;
  if (error) return showAlert('auth-alert', error.message);

  if (data.session) {
    const next = nextPage();
    if (next) location.href = next; else init();
  } else {
    showPanel('login');
    showAlert('auth-alert', 'Account created! We sent a confirmation link to ' + email + '. Open it, then log in here.', 'success');
  }
});

// ---------- Forgot password ----------
$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter; if (btn) btn.disabled = true;
  await supabase.auth.resetPasswordForEmail($('fp-email').value.trim(), { redirectTo: location.origin + location.pathname });
  if (btn) btn.disabled = false;
  // Same message whether or not the email exists, so nobody can check which emails have accounts
  showAlert('auth-alert', 'If that email has an account, a reset link is on its way. Check your inbox.', 'success');
});

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('rp-password').value;
  const pw2 = $('rp-password2').value;
  const pwErr = getPasswordValidationError(pw, pw2);
  if (pwErr) return showAlert('reset-alert', pwErr);

  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) return showAlert('reset-alert', error.message);
  recovering = false;
  history.replaceState(null, '', location.pathname);
  showAlert('reset-alert', 'Password saved.', 'success');
  setTimeout(init, 800);
});

// ---------- Logged-in area ----------
async function loadProfile() {
  const { data } = await supabase.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  profile = data || { id: currentUser.id, full_name: currentUser.user_metadata?.full_name || '', phone: currentUser.user_metadata?.phone || '', momo_accounts: [] };
  if (!data) await supabase.from('profiles').upsert({ id: currentUser.id, email: currentUser.email, full_name: profile.full_name, phone: profile.phone });

  $('hello').textContent = profile.full_name ? `Hi, ${profile.full_name.split(' ')[0]}` : 'My Account';
  $('account-email').textContent = currentUser.email;
  $('pf-name').value = profile.full_name || '';
  setPhone($('pf-phone'), profile.phone || '');
  $('pf-address').value = profile.address || '';
  renderMomo();
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = $('pf-phone').value.trim();
  if (!validPhone(phone)) return showAlert('profile-alert', 'Please enter a valid 10-digit phone number starting with 0.');
  const update = {
    full_name: $('pf-name').value.trim(),
    phone,
    address: $('pf-address').value.trim(),
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from('profiles').update(update).eq('id', currentUser.id);
  if (error) return showAlert('profile-alert', error.message);
  Object.assign(profile, update);
  $('hello').textContent = `Hi, ${update.full_name.split(' ')[0] || 'there'}`;
  showAlert('profile-alert', 'Profile saved.', 'success');
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('pw-new').value;
  const pw2 = $('pw-new2').value;
  const pwErr = getPasswordValidationError(pw, pw2);
  if (pwErr) return showAlert('pw-alert', pwErr);

  // Check the current password first, so someone using an unlocked phone can't change it
  const { error: checkErr } = await supabase.auth.signInWithPassword({ email: currentUser.email, password: $('pw-current').value });
  if (checkErr) return showAlert('pw-alert', 'Your current password is not correct.');
  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) return showAlert('pw-alert', error.message);
  e.target.reset();
  showAlert('pw-alert', 'Password updated.', 'success');
});

// ---------- Saved MoMo numbers ----------
function renderMomo() {
  const list = $('momo-list');
  const accounts = Array.isArray(profile.momo_accounts) ? profile.momo_accounts : [];
  if (accounts.length === 0) {
    list.innerHTML = '<p class="muted">No saved numbers yet.</p>';
    return;
  }
  list.innerHTML = '';
  accounts.forEach((acc, idx) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div><b>${escapeHtml(NETWORKS[acc.network] || acc.network)}</b> · ${escapeHtml(acc.number)}
        ${acc.is_default ? '<span class="badge paid" style="margin-left:6px;">Default</span>' : ''}</div>
      <div style="display:flex;gap:8px;">
        ${acc.is_default ? '' : '<button class="btn btn-outline btn-sm" data-act="default">Make default</button>'}
        <button class="btn btn-outline btn-sm" data-act="remove"><i class="fa-solid fa-trash"></i></button>
      </div>`;
    row.querySelector('[data-act="remove"]').addEventListener('click', () => saveMomo(accounts.filter((_, i) => i !== idx)));
    row.querySelector('[data-act="default"]')?.addEventListener('click', () =>
      saveMomo(accounts.map((a, i) => ({ ...a, is_default: i === idx }))));
    list.appendChild(row);
  });
}

async function saveMomo(accounts) {
  if (accounts.length && !accounts.some((a) => a.is_default)) accounts[0].is_default = true;
  const { error } = await supabase.from('profiles').update({ momo_accounts: accounts, updated_at: new Date().toISOString() }).eq('id', currentUser.id);
  if (error) return showAlert('momo-alert', error.message);
  profile.momo_accounts = accounts;
  showAlert('momo-alert', '');
  renderMomo();
}

$('momo-add').addEventListener('click', () => {
  const number = localPhone($('momo-number').value);
  const network = $('momo-network').value;
  if (number.length !== 10) return showAlert('momo-alert', 'Enter a 10-digit number, e.g. 0244123456.');
  const accounts = Array.isArray(profile.momo_accounts) ? [...profile.momo_accounts] : [];
  if (accounts.some((a) => a.number === number && a.network === network)) return showAlert('momo-alert', 'That number is already saved.');
  if (accounts.length >= 5) return showAlert('momo-alert', 'You can save up to 5 numbers.');
  accounts.push({ network, number, is_default: accounts.length === 0 });
  setPhone($('momo-number'), '');
  saveMomo(accounts);
});

// ---------- Orders ----------
async function loadOrders() {
  const box = $('orders-list');
  const { data, error } = await supabase
    .from('orders')
    .select('order_number,status,total,created_at,payment_reference,order_type,items')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { box.innerHTML = '<p class="muted">Could not load your orders.</p>'; return; }
  const orders = (data || []).filter((o) => o.status !== 'cancelled' || o.payment_reference);
  if (orders.length === 0) { box.innerHTML = '<p class="muted">No orders yet. <a href="index.html" style="color:var(--accent-hover);text-decoration:underline;">Start shopping</a></p>'; return; }
  box.innerHTML = '';
  orders.forEach((o) => {
    const count = (o.items || []).reduce((s, it) => s + Number(it.qty || 0), 0);
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div>
        <b>${escapeHtml(o.order_number)}</b> <span class="badge ${o.status}">${STATUS_LABELS[o.status] || o.status}</span><br>
        <small class="muted">${new Date(o.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${count} item(s)${o.order_type === 'wholesale' ? ' · Wholesale' : ''}</small>
      </div>
      <div style="text-align:right;">
        <b>GHS ${Number(o.total).toFixed(2)}</b><br>
        <a class="link-btn" href="order.html?reference=${encodeURIComponent(o.payment_reference || '')}">Track order</a>
      </div>`;
    box.appendChild(row);
  });
}

$('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.href = 'index.html';
});

// ---------- Start ----------
initPhoneInputs();
initPasswordToggles();
bindPasswordChecklist('su-password', 'su-password2', 'su');
bindPasswordChecklist('rp-password', 'rp-password2', 'rp');
bindPasswordChecklist('pw-new', 'pw-new2', 'pw');

supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') { recovering = true; showView('reset'); }
});

async function init() {
  if (recovering || /type=recovery/.test(location.hash)) { recovering = true; showView('reset'); return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { showView('auth'); return; }
  currentUser = session.user;
  showView('profile');
  await loadProfile();
  loadOrders();
}

init();
