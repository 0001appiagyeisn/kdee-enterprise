// Phone number boxes: digits only, never more than 10, with a live counter underneath (e.g. 7/10).
export function normalizeGhPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length > 10) d = '0' + d.slice(3); // +233 244 123 456 -> 0244123456
  return d.slice(0, 10);
}

export const isValidGhPhone = (p) => /^0\d{9}$/.test(String(p || '').replace(/\D/g, ''));

function ensureCounter(input) {
  let el = input.nextElementSibling;
  if (!el || !el.classList.contains('phone-counter')) {
    el = document.createElement('div');
    el.className = 'phone-counter';
    el.setAttribute('aria-live', 'polite');
    input.insertAdjacentElement('afterend', el);
  }
  return el;
}

export function updateCounter(input) {
  const el = ensureCounter(input);
  const len = input.value.length;
  el.classList.remove('ok', 'warn');
  if (len === 0) { el.textContent = '0/10'; return; }
  if (len === 10 && input.value[0] !== '0') { el.textContent = '10/10 · Ghana numbers start with 0'; el.classList.add('warn'); return; }
  if (len === 10) { el.textContent = '10/10 ✓'; el.classList.add('ok'); return; }
  el.textContent = `${len}/10`;
}

// Use this when you set a phone box from code (for example a saved profile number)
export function setPhone(input, value) {
  if (!input) return;
  input.value = normalizeGhPhone(value);
  updateCounter(input);
}

export function initPhoneInputs(root = document) {
  root.querySelectorAll('input[type="tel"]').forEach((input) => {
    if (input.dataset.phoneReady) return;
    input.dataset.phoneReady = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'tel-national');
    input.addEventListener('input', () => {
      const clean = normalizeGhPhone(input.value);
      if (clean !== input.value) input.value = clean;
      updateCounter(input);
    });
    setPhone(input, input.value);
  });
}
