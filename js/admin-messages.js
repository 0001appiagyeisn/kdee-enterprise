// Admin: Messages tab (customer chat inbox). Works alongside admin.js (login) and admin-orders.js (tabs).
import { supabase } from './supabase-config.js';

const $ = (id) => document.getElementById(id);

let isAdmin = false;
let convs = [];
let activeId = null;
let channel = null;
let reloadTimer = null;
const drawn = new Set();

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeText = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const displayName = (c) => c.customer_name || c.customer_email || 'Customer';

// ---------------- Conversation list ----------------
async function loadConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('last_message_at', { ascending: false })
    .limit(300);
  if (error) {
    $('conv-list').innerHTML = `<p class="img-hint">Could not load messages (${escapeHtml(error.message)}). Have you run database-update-5.sql?</p>`;
    return;
  }
  convs = data || [];
  renderList();
}

function renderList() {
  const term = $('conv-search').value.trim().toLowerCase();
  const list = convs.filter((c) => !term || [c.customer_name, c.customer_email].join(' ').toLowerCase().includes(term));

  const totalUnread = convs.reduce((sum, c) => sum + Number(c.admin_unread || 0), 0);
  $('msg-badge').textContent = totalUnread;
  $('msg-badge').hidden = totalUnread === 0;

  const box = $('conv-list');
  if (!list.length) {
    box.innerHTML = `<p class="img-hint" style="text-align:center;padding:24px 0;">${convs.length ? 'No match.' : 'No messages yet.'}</p>`;
    return;
  }
  box.innerHTML = '';
  list.forEach((c) => {
    const item = document.createElement('div');
    const unread = Number(c.admin_unread || 0);
    item.className = 'conv-item' + (unread ? ' unread' : '') + (c.id === activeId ? ' active' : '');
    item.innerHTML = `
      <div class="c-top"><b>${escapeHtml(displayName(c))}</b>${unread ? `<span class="conv-count">${unread}</span>` : ''}</div>
      <div class="c-prev">${escapeHtml(c.last_message || '')}</div>
      <div class="c-time">${c.last_message_at ? timeText(c.last_message_at) : ''}</div>`;
    item.addEventListener('click', () => openConversation(c.id));
    box.appendChild(item);
  });
}

// ---------------- Thread ----------------
function drawMessage(m) {
  if (drawn.has(m.id)) return;
  drawn.add(m.id);
  const body = $('thread-body');
  const div = document.createElement('div');
  div.className = 'msg ' + m.sender;
  const note = m.sender === 'customer' && m.forward_state === 'sent' ? ' · sent to your WhatsApp' : '';
  div.innerHTML = `${escapeHtml(m.body)}<small>${m.sender === 'admin' ? 'You' : 'Customer'} · ${timeText(m.created_at)}${note}</small>`;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

async function openConversation(id) {
  const conv = convs.find((c) => c.id === id);
  if (!conv) return;
  activeId = id;
  drawn.clear();

  $('thread-empty').style.display = 'none';
  $('thread-box').style.display = 'flex';
  $('thread-box').hidden = false;
  $('chat-admin').classList.add('thread-open');
  $('th-name').textContent = displayName(conv);
  $('th-contact').textContent = conv.customer_email || '';
  $('thread-body').innerHTML = '<div class="thread-empty">Loading...</div>';

  const { data: msgs } = await supabase.from('messages').select('*').eq('conversation_id', id)
    .order('created_at', { ascending: true }).limit(500);
  $('thread-body').innerHTML = '';
  (msgs || []).forEach(drawMessage);

  // Show the customer's phone number
  const { data: prof } = await supabase.from('profiles').select('phone').eq('id', conv.user_id).maybeSingle();
  if (prof?.phone && activeId === id) {
    $('th-contact').innerHTML = `${escapeHtml(conv.customer_email || '')} · <a href="tel:${escapeHtml(prof.phone)}" style="color:#1d5a96;text-decoration:underline;">${escapeHtml(prof.phone)}</a>`;
  }

  await markRead(id);
  renderList();
}

async function markRead(id) {
  await supabase.rpc('mark_conversation_read', { p_conversation_id: id });
  const c = convs.find((x) => x.id === id);
  if (c) c.admin_unread = 0;
}

$('conv-search')?.addEventListener('input', renderList);

$('back-conv')?.addEventListener('click', () => {
  $('chat-admin').classList.remove('thread-open');
});

$('th-orders')?.addEventListener('click', () => {
  const conv = convs.find((c) => c.id === activeId);
  if (!conv) return;
  $('ord-search').value = conv.customer_email || '';
  $('ord-status').value = 'all';
  $('ord-search').dispatchEvent(new Event('input'));
  document.querySelector('.admin-tabs [data-tab="orders"]')?.click();
});

$('th-delete-conv')?.addEventListener('click', async () => {
  if (!activeId) return;
  const conv = convs.find((c) => c.id === activeId);
  const name = displayName(conv);
  if (!confirm(`Are you sure you want to delete this conversation with ${name}? All messages will be permanently deleted.`)) {
    return;
  }
  const btn = $('th-delete-conv');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  // Delete all messages in the conversation, then delete the conversation record
  await supabase.from('messages').delete().eq('conversation_id', activeId);
  const { error } = await supabase.from('conversations').delete().eq('id', activeId);
  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Chat';
  if (error) {
    alert('Could not delete chat: ' + error.message);
    return;
  }
  activeId = null;
  $('thread-box').style.display = 'none';
  $('thread-box').hidden = true;
  $('thread-empty').style.display = 'block';
  $('chat-admin').classList.remove('thread-open');
  await loadConversations();
});

// ---------------- Reply ----------------
$('reply-input')?.addEventListener('input', () => {
  const el = $('reply-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
});
$('reply-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('reply-form').requestSubmit(); }
});

$('reply-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('reply-input').value.trim();
  if (!body || !activeId) return;
  $('reply-send').disabled = true;
  const { data, error } = await supabase.from('messages')
    .insert({ conversation_id: activeId, sender: 'admin', body })
    .select().single();
  $('reply-send').disabled = false;
  if (error) { alert('Reply not sent: ' + error.message); return; }
  $('reply-input').value = '';
  $('reply-input').style.height = 'auto';
  drawMessage(data);
  loadConversations();
});

// ---------------- Live updates ----------------
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadConversations, 400);
}

async function start() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { stop(); return; }
  const { data } = await supabase.rpc('is_admin');
  isAdmin = data === true;
  if (!isAdmin) { stop(); return; }

  await loadConversations();

  if (!channel) {
    channel = supabase
      .channel('admin-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
        const m = payload.new;
        if (m.conversation_id === activeId) {
          drawMessage(m);
          if (m.sender === 'customer') await markRead(activeId);
        }
        scheduleReload();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, scheduleReload)
      .subscribe();
  }
}

function stop() {
  isAdmin = false;
  convs = [];
  activeId = null;
  if (channel) { supabase.removeChannel(channel); channel = null; }
}

// Open the inbox when the Messages tab is clicked
document.querySelector('.admin-tabs [data-tab="messages"]')?.addEventListener('click', () => { if (isAdmin) loadConversations(); });

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(start, 400);
  if (event === 'SIGNED_OUT') stop();
});
