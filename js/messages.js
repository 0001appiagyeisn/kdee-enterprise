import { supabase } from './supabase-config.js';

const $ = (id) => document.getElementById(id);
let user = null;
let conv = null;
const seen = new Set();

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeText = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function showAlert(text) {
  const el = $('chat-alert');
  el.textContent = text || '';
  el.className = 'alert' + (text ? ' show error' : '');
}

function drawMessage(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  const thread = $('thread');
  thread.querySelector('.chat-empty')?.remove();
  const mine = m.sender === 'customer';
  const div = document.createElement('div');
  div.className = 'bubble ' + (mine ? 'mine' : 'theirs');
  div.innerHTML = `${escapeHtml(m.body)}<small>${mine ? 'You' : 'KD Wisdom'} · ${timeText(m.created_at)}</small>`;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

async function markRead() {
  if (conv) await supabase.rpc('mark_conversation_read', { p_conversation_id: conv.id });
}

async function start() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { location.href = 'account.html?next=messages.html'; return; }
  user = session.user;

  const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const name = prof?.full_name || user.user_metadata?.full_name || '';

  // Make sure this customer has a conversation (only created once)
  await supabase.from('conversations')
    .upsert({ user_id: user.id, customer_name: name, customer_email: user.email }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data: c, error } = await supabase.from('conversations').select('*').eq('user_id', user.id).maybeSingle();
  if (error || !c) {
    $('thread').innerHTML = '<div class="chat-empty">Chat is not available yet. Please try again later.</div>';
    return;
  }
  conv = c;

  const { data: msgs } = await supabase.from('messages').select('*').eq('conversation_id', conv.id)
    .order('created_at', { ascending: true }).limit(300);
  $('thread').innerHTML = '';
  (msgs || []).forEach(drawMessage);
  if (!msgs || msgs.length === 0) {
    $('thread').innerHTML = '<div class="chat-empty">👋 Hi! Send us a message and we will reply here.</div>';
  }
  markRead();

  supabase.channel('chat-' + conv.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conv.id}` }, (payload) => {
      drawMessage(payload.new);
      if (payload.new.sender === 'admin') markRead();
    })
    .subscribe();
}

$('chat-input').addEventListener('input', () => {
  const el = $('chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  $('chat-count').textContent = `${el.value.length}/1000`;
});
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); }
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('chat-input').value.trim();
  if (!body || !conv) return;
  showAlert('');
  $('chat-send').disabled = true;
  const { data, error } = await supabase.from('messages')
    .insert({ conversation_id: conv.id, sender: 'customer', body })
    .select().single();
  $('chat-send').disabled = false;
  if (error) { showAlert(error.message.includes('too fast') ? error.message : 'Message not sent. Please try again.'); return; }
  $('chat-input').value = '';
  $('chat-input').style.height = 'auto';
  $('chat-count').textContent = '0/1000';
  drawMessage(data);
});

start();
