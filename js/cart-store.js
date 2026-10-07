// Carts are saved per account, so one person's cart never shows up for someone else.
// Not logged in = "guest" cart. When a guest logs in, the guest cart is merged into their own cart.
const SIDE = { retail: 'kd_cart', wholesale: 'kd_ws_cart' };

export const cartKey = (type, owner) => `${SIDE[type === 'wholesale' ? 'wholesale' : 'retail']}:${owner || 'guest'}`;

function read(key) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function write(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* storage blocked */ }
}

// Old versions stored one shared cart under these names. Remove it so it can't leak between accounts.
export function clearLegacyCartKeys() {
  try { localStorage.removeItem('kd_cart'); localStorage.removeItem('kd_ws_cart'); } catch (e) { /* ignore */ }
}

export function clearGuestCarts() {
  try {
    localStorage.removeItem(cartKey('retail', 'guest'));
    localStorage.removeItem(cartKey('wholesale', 'guest'));
  } catch (e) { /* ignore */ }
}

export function adoptGuestCart(userId) {
  ['retail', 'wholesale'].forEach((type) => {
    const guest = read(cartKey(type, 'guest'));
    if (!guest.length) return;
    const mine = read(cartKey(type, userId));
    guest.forEach((item) => {
      const hit = mine.find((m) => m.id === item.id && (m.size || '') === (item.size || '') && (m.color || '') === (item.color || ''));
      if (hit) hit.qty = Number(hit.qty) + Number(item.qty);
      else mine.push(item);
    });
    write(cartKey(type, userId), mine);
    localStorage.removeItem(cartKey(type, 'guest'));
  });
}
