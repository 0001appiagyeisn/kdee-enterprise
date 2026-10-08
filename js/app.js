import { supabase, WHATSAPP_NUMBER } from './supabase-config.js';
import { cartKey, adoptGuestCart, clearGuestCarts, clearLegacyCartKeys } from './cart-store.js';

let products = [];
let cart = [];
let activeSlideshowImages = [];
let currentSlideIndex = 0;
let realtimeStarted = false;
let activeCategory = 'all';
let searchTerm = '';

// Carts are saved in the browser so they survive going to the checkout page
function readSaved(key) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
// Whose cart is on screen: a user id, or 'guest' when nobody is logged in
let cartOwner = 'guest';
function saveCarts() {
  try { localStorage.setItem(cartKey('retail', cartOwner), JSON.stringify(cart)); } catch (e) { /* storage blocked */ }
}
function loadCartsFor(owner) {
  cartOwner = owner;
  cart = readSaved(cartKey('retail', owner)).filter((i) => i && i.id && i.size && Number(i.qty) > 0);
  try { localStorage.removeItem(cartKey('wholesale', owner)); } catch (e) { /* old separate bulk cart is no longer used */ }
  syncCartWithProducts();
}

// ---------- Prices: 3+ pieces of the same item (any sizes) = wholesale price ----------
const wsMinOf = (p) => Math.max(parseInt(p.wholesale_min_qty ?? p.wsMin, 10) || 3, 1);
const productQty = (id) => cart.filter((i) => i.id === id).reduce((s, i) => s + Number(i.qty), 0);
function unitPrice(item) {
  return Number(item.wsPrice) > 0 && productQty(item.id) >= wsMinOf(item) ? Number(item.wsPrice) : Number(item.price);
}
const isWholesaleLine = (item) => unitPrice(item) !== Number(item.price);

// Keep cart prices, names and photos in step with the shop (and drop items that were removed)
function syncCartWithProducts() {
  if (products.length) {
    cart = cart.filter((i) => products.some((p) => p.id === i.id));
    cart.forEach((i) => {
      const p = products.find((x) => x.id === i.id);
      i.name = p.name;
      i.price = Number(p.price);
      i.wsPrice = Number(p.wholesale_price) > 0 ? Number(p.wholesale_price) : 0;
      i.wsMin = wsMinOf(p);
      i.img = getImages(p)[0];
    });
  }
  updateCartUI();
}

// Show a small number on the chat button when the shop has replied
async function refreshChatBadge(uid) {
  const badge = document.getElementById('chat-fab-badge');
  if (!badge) return;
  if (!uid) { badge.hidden = true; return; }
  const { data } = await supabase.from('conversations').select('customer_unread').eq('user_id', uid).maybeSingle();
  const n = Number(data?.customer_unread || 0);
  badge.textContent = n;
  badge.hidden = n === 0;
}

// Logging in/out swaps the cart, so accounts never see each other's items
supabase.auth.onAuthStateChange((event, session) => {
  const uid = session?.user?.id || null;
  if (!uid) {
    if (event === 'SIGNED_OUT') clearGuestCarts();
    loadCartsFor('guest');
    refreshChatBadge(null);
    return;
  }
  if (uid !== cartOwner) {
    adoptGuestCart(uid);
    loadCartsFor(uid);
  }
  refreshChatBadge(uid);
});
// Typing one of these in the search box opens the admin login page
const ADMIN_KEYWORDS = ['iamadminapp', 'iamadminkdw'];
let selectedSize = '';
let selectedColor = '';
const SIZES = ['L', 'XL', 'XXL', 'XXXL'];
const isValidPhone = (p) => /^\+?[\d\s-]{9,15}$/.test(p) && p.replace(/\D/g, '').length >= 9;

const COLOR_HEX_MAP = {
  'black': '#1a1a1a',
  'white': '#ffffff',
  'navy': '#1b2a47',
  'navy blue': '#1b2a47',
  'blue': '#2563eb',
  'sky blue': '#38bdf8',
  'khaki': '#c3b091',
  'beige': '#e6d7b8',
  'wine': '#722f37',
  'burgundy': '#800020',
  'maroon': '#800000',
  'olive': '#556b2f',
  'olive green': '#556b2f',
  'green': '#16a34a',
  'grey': '#6b7280',
  'gray': '#6b7280',
  'charcoal': '#374151',
  'red': '#dc2626',
  'pink': '#ec4899',
  'yellow': '#eab308',
  'teal': '#0d9488',
  'tan': '#d2b48c',
  'brown': '#78350f',
  'orange': '#ea580c',
  'camouflage': '#4a5d4e'
};

function getAvailableColors(prod) {
  if (!prod) return [];
  // 1. Direct colors field if present
  if (Array.isArray(prod.colors) && prod.colors.length > 0) {
    return prod.colors.map(c => String(c).trim()).filter(Boolean);
  }
  if (typeof prod.colors === 'string' && prod.colors.trim()) {
    return prod.colors.split(',').map(c => c.trim()).filter(Boolean);
  }
  // 2. Check description for "Colors: ..." or "Available Colors: ..."
  const desc = String(prod.description || '');
  const match = desc.match(/(?:Available\s+)?Colors?:\s*([^\n\r]+)/i);
  if (match) {
    const list = match[1].split(/[,/|]/).map(c => c.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  // 3. Check title or description for "Assorted Colors" or "Assortment"
  const nameDesc = (String(prod.name || '') + ' ' + desc).toLowerCase();
  if (nameDesc.includes('assorted') || nameDesc.includes('assortment')) {
    return ['Black', 'White', 'Navy Blue', 'Wine / Burgundy', 'Olive Green', 'Grey', 'Khaki / Beige'];
  }
  // 4. Check for prominent colors in name/description
  const standardPalette = ['Black', 'Navy Blue', 'Khaki', 'White', 'Grey', 'Olive Green', 'Wine'];
  const detected = standardPalette.filter(c => nameDesc.includes(c.toLowerCase()));
  if (detected.length > 0) {
    return detected;
  }
  return [];
}

const DEFAULT_CATEGORIES = [
  { key: 'casual', label: 'Casual' },
  { key: 'official', label: 'Official' },
  { key: 'jeans', label: 'Jeans' },
  { key: 'shirts', label: 'Shirts' },
  { key: 'tshirts', label: 'T-Shirts' },
  { key: 'shorts', label: 'Shorts' },
  { key: 'trousers', label: 'Trousers' },
  { key: 'sweatpants', label: 'Sweatpants' },
  { key: 'jackets', label: 'Jackets' },
  { key: 'accessories', label: 'Accessories' }
];
// Starts with the built-in list, then is replaced by the categories you manage in the admin page
let CATEGORIES = [{ key: 'all', label: 'All' }, ...DEFAULT_CATEGORIES];

async function loadCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error || !data) return; // keep the built-in list
  CATEGORIES = [{ key: 'all', label: 'All' }, ...data.map((c) => ({ key: c.key, label: c.label }))];
  if (!CATEGORIES.some((c) => c.key === activeCategory)) activeCategory = 'all';
  renderChips();
  renderProducts();
}
// Older items seeded as "short_jeans" show under Shorts
const normCat = (c) => (c === 'short_jeans' ? 'shorts' : (c || ''));

const productGrid = document.getElementById('product-grid');
const cartBadge = document.getElementById('cart-badge');
const cartDrawer = document.getElementById('cart-drawer');
const cartDrawerOverlay = document.getElementById('cart-drawer-overlay');
const cartItemsContainer = document.getElementById('cart-items-container');
const cartTotalPrice = document.getElementById('cart-total-price');

const productModal = document.getElementById('product-modal');
const modalSlideshowImg = document.getElementById('modal-slideshow-img');
const slideCounter = document.getElementById('slide-counter');
const modalTitle = document.getElementById('modal-title');
const modalPrice = document.getElementById('modal-price');
const modalStock = document.getElementById('modal-stock');
const modalDescription = document.getElementById('modal-description');
const modalAddCartBtn = document.getElementById('modal-add-cart-btn');

// 3D Hero Scene with Rotating Gold Wireframe Mesh Only
function init3DHero() {
  const canvas = document.getElementById('hero-3d-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });

  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Rotating Wireframe Mesh
  const wireframeGeo = new THREE.IcosahedronGeometry(2.5, 1);
  const wireframeMat = new THREE.MeshBasicMaterial({
    color: 0xd4af37,
    wireframe: true,
    transparent: true,
    opacity: 0.85
  });
  const wireframeMesh = new THREE.Mesh(wireframeGeo, wireframeMat);
  scene.add(wireframeMesh);

  // Ambient Light
  const ambientLight = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambientLight);

  camera.position.z = 6.5;

  let mouseX = 0;
  let mouseY = 0;

  window.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 0.4;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 0.4;
  });

  function animate() {
    requestAnimationFrame(animate);

    wireframeMesh.rotation.x += 0.003;
    wireframeMesh.rotation.y += 0.005;

    // Smooth floating movement on mouse move
    scene.rotation.y += (mouseX - scene.rotation.y) * 0.05;
    scene.rotation.x += (mouseY - scene.rotation.x) * 0.05;

    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  });
}

// Product pages (made for Google) send visitors here with ?p=<product id>: open that item's size + quantity step
let linkedProductHandled = false;
function openFromLink() {
  if (linkedProductHandled) return;
  linkedProductHandled = true;
  const id = new URLSearchParams(location.search).get('p');
  if (!id) return;
  const prod = products.find((p) => String(p.id) === id);
  history.replaceState(null, '', location.pathname + location.hash);
  if (prod) openModal(prod);
}

// Load Products from Supabase
async function loadProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching products from Supabase:', error);
    return;
  }

  products = data || [];
  renderProducts();
  renderWholesale();
  syncCartWithProducts();
  openFromLink();

  // Supabase Realtime Subscription (start only once)
  if (realtimeStarted) return;
  realtimeStarted = true;
  supabase
    .channel('public:products')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
      loadProducts();
    })
    .subscribe();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function getImages(prod, fallback) {
  if (prod.images && prod.images.length > 0) return prod.images;
  if (prod.image_url) return [prod.image_url];
  return [fallback || 'https://via.placeholder.com/300'];
}

// ---------- Categories & Search ----------
function renderChips() {
  const wrap = document.getElementById('category-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  CATEGORIES.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (cat.key === activeCategory ? ' active' : '');
    btn.textContent = cat.label;
    btn.addEventListener('click', () => {
      activeCategory = cat.key;
      renderChips();
      renderProducts();
    });
    wrap.appendChild(btn);
  });
}

function bindSearch() {
  const input = document.getElementById('search-input');
  const runSearch = () => {
    searchTerm = input.value.trim().toLowerCase();
    if (ADMIN_KEYWORDS.includes(searchTerm)) {
      window.location.href = 'admin.html';
      return;
    }
    renderProducts();
  };
  if (input) {
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runSearch(); productGrid?.scrollIntoView({ behavior: 'smooth' }); } });
  }
  document.getElementById('search-btn')?.addEventListener('click', () => {
    runSearch();
    productGrid?.scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('search-nav-btn')?.addEventListener('click', () => {
    if (location.hash === '#wholesale') location.hash = '#new-arrivals';
    else document.getElementById('new-arrivals')?.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => input?.focus(), 400);
  });
}

function getFilteredProducts() {
  return products.filter((p) => {
    const cat = normCat(p.category);
    if (activeCategory !== 'all' && cat !== activeCategory) return false;
    if (!searchTerm) return true;
    const label = (CATEGORIES.find((c) => c.key === cat) || {}).label || '';
    return [p.name, p.description, label].join(' ').toLowerCase().includes(searchTerm);
  });
}

function renderProducts() {
  if (!productGrid) return;
  productGrid.innerHTML = '';

  const list = getFilteredProducts();
  if (list.length === 0) {
    const filtered = searchTerm || activeCategory !== 'all';
    const catName = (CATEGORIES.find((c) => c.key === activeCategory) || {}).label || '';
    const msg = searchTerm
      ? `No products match "${escapeHtml(searchTerm)}".`
      : (activeCategory !== 'all' ? `No ${escapeHtml(catName)} products yet.` : 'No products available yet.');
    productGrid.innerHTML = `<div class="no-results"><p>${msg}</p>` +
      (filtered ? '<button type="button" class="btn btn-primary" id="reset-filters"><i class="fa-solid fa-arrow-left"></i> Show All Products</button>' : '') +
      '</div>';
    document.getElementById('reset-filters')?.addEventListener('click', () => {
      activeCategory = 'all';
      searchTerm = '';
      const input = document.getElementById('search-input');
      if (input) input.value = '';
      renderChips();
      renderProducts();
    });
    return;
  }

  list.forEach(prod => {
    const images = getImages(prod);
    const primaryImg = images[0];
    const isOutOfStock = Number(prod.stock) <= 0;

    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="product-img-wrapper">
        <img src="${escapeHtml(primaryImg)}" alt="${escapeHtml(prod.name)}">
        ${isOutOfStock ? '<span class="badge out-of-stock">Out of Stock</span>' : '<span class="badge">New</span>'}
      </div>
      <div class="product-info">
        <div>
          <h3>${escapeHtml(prod.name)}</h3>
          <div class="product-price">GHS ${Number(prod.price).toFixed(2)}</div>
        </div>
        <button class="btn btn-primary add-to-cart-quick" ${isOutOfStock ? 'disabled' : ''}>
          ${isOutOfStock ? 'Sold Out' : 'Add To Cart'}
        </button>
      </div>
    `;

    card.querySelector('.product-img-wrapper').addEventListener('click', () => openModal(prod));

    const addBtn = card.querySelector('.add-to-cart-quick');
    if (addBtn && !isOutOfStock) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSizeDialog(prod);
      });
    }

    productGrid.appendChild(card);
  });
}

// ---------- Wholesale ----------
function renderWholesale() {
  const grid = document.getElementById('wholesale-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const list = products.filter((p) => Number(p.wholesale_price) > 0);
  if (list.length === 0) {
    grid.innerHTML = '<p class="no-results">Wholesale items will be listed here soon. Message us for bulk prices.</p>';
    return;
  }

  list.forEach((prod) => {
    const min = wsMinOf(prod);
    const stock = Number(prod.stock) || 0;
    const canOrder = stock >= min;

    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="product-img-wrapper">
        <img src="${escapeHtml(getImages(prod)[0])}" alt="${escapeHtml(prod.name)}">
        <span class="badge">Wholesale</span>
      </div>
      <div class="product-info">
        <div>
          <h3>${escapeHtml(prod.name)}</h3>
          <div class="product-price">GHS ${Number(prod.wholesale_price).toFixed(2)} <small>/ piece</small></div>
          <div class="ws-min">Minimum ${min} pieces (any sizes) &middot; ${stock} in stock<br>Regular price GHS ${Number(prod.price).toFixed(2)}</div>
        </div>
        <button class="btn btn-primary ws-add" ${canOrder ? '' : 'disabled'}>${canOrder ? 'Add To Cart' : 'Low Stock'}</button>
      </div>
    `;
    card.querySelector('.product-img-wrapper').addEventListener('click', () => openModal(prod));
    card.querySelector('.ws-add').addEventListener('click', () => openSizeDialog(prod, { minQty: min, qty: min, wholesale: true }));
    grid.appendChild(card);
  });
}

function renderColorPicker(containerId, colors, onSelect) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  if (!colors || !colors.length) return;
  colors.forEach((col) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = col === selectedColor;
    btn.className = 'color-btn' + (isSelected ? ' active' : '');
    const cleanCol = col.toLowerCase().trim();
    let dotColor = '#999999';
    for (const [key, hex] of Object.entries(COLOR_HEX_MAP)) {
      if (cleanCol.includes(key)) { dotColor = hex; break; }
    }
    const isWhite = dotColor === '#ffffff' || cleanCol === 'white' || cleanCol.includes('white');
    const dotBorder = isWhite ? 'border:1.5px solid #b5b5b5;box-shadow:inset 0 0 2px rgba(0,0,0,0.25);' : '';
    btn.innerHTML = `<span class="color-dot" style="background-color:${dotColor};${dotBorder}"></span><span>${escapeHtml(col)}</span>${isSelected ? '<i class="fa-solid fa-check" style="font-size:0.75rem;margin-left:4px;"></i>' : ''}`;
    btn.addEventListener('click', () => {
      selectedColor = col;
      renderColorPicker(containerId, colors, onSelect);
      if (onSelect) onSelect(col);
    });
    box.appendChild(btn);
  });
}

let modalProd = null;
let modalOpts = {};

function showModalError(msg) {
  const el = document.getElementById('modal-validation-msg');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function hideModalError() {
  const el = document.getElementById('modal-validation-msg');
  if (el) {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function updateModalPrice() {
  const prod = modalProd;
  if (!prod) return;
  const qtyInput = document.getElementById('modal-qty-input');
  const qty = Math.max(parseInt(qtyInput ? qtyInput.value : 1, 10) || 1, 1);
  const wp = Number(prod.wholesale_price);
  const min = wsMinOf(prod);
  const totalPieces = productQty(prod.id) + qty;
  const wholesale = wp > 0 && totalPieces >= min;
  const unit = wholesale ? wp : Number(prod.price);

  const priceEl = document.getElementById('modal-price');
  if (priceEl) {
    priceEl.innerHTML = wholesale
      ? `GHS ${wp.toFixed(2)} <small style="font-size:0.8rem;color:var(--text-muted);text-decoration:line-through;">GHS ${Number(prod.price).toFixed(2)}</small>`
      : `GHS ${Number(prod.price).toFixed(2)}`;
  }

  const noteEl = document.getElementById('modal-qty-note');
  if (noteEl) {
    let note = qty > 0 ? `Subtotal: <b>GHS ${(unit * qty).toFixed(2)}</b>` : '';
    if (wp > 0 && !wholesale) note += ` · <span style="color:var(--accent);">Buy ${min}+ for GHS ${wp.toFixed(2)} wholesale each</span>`;
    if (wholesale) note += ' · <span style="color:#2e7d32;font-weight:600;">✅ Wholesale price applied!</span>';
    noteEl.innerHTML = note;
  }
}

function openModal(prod, opts = {}) {
  modalProd = prod;
  modalOpts = opts;
  activeSlideshowImages = getImages(prod, 'https://via.placeholder.com/400');
  currentSlideIndex = 0;

  modalTitle.textContent = prod.name;
  modalStock.textContent = prod.stock > 0 ? `In Stock (${prod.stock} left)` : 'Out of Stock';
  modalDescription.textContent = prod.description || 'No description provided.';

  modalAddCartBtn.disabled = prod.stock <= 0;
  modalAddCartBtn.textContent = prod.stock > 0 ? 'Add To Cart' : 'Sold Out';

  hideModalError();

  const colors = getAvailableColors(prod);
  const colorLabel = document.getElementById('modal-color-label');
  const colorPicker = document.getElementById('modal-color-picker');
  if (colors.length > 0) {
    if (colorLabel) colorLabel.style.display = 'block';
    if (colorPicker) colorPicker.style.display = 'flex';
    selectedColor = opts.color || (colors.length === 1 ? colors[0] : '');
    renderColorPicker('modal-color-picker', colors, (col) => {
      selectedColor = col;
      hideModalError();
    });
  } else {
    if (colorLabel) colorLabel.style.display = 'none';
    if (colorPicker) colorPicker.style.display = 'none';
    selectedColor = '';
  }

  selectedSize = opts.size || '';
  renderSizePicker('size-picker');

  const min = opts.minQty || (opts.wholesale ? wsMinOf(prod) : 1);
  const qtyInput = document.getElementById('modal-qty-input');
  if (qtyInput) {
    qtyInput.min = String(min);
    qtyInput.value = String(opts.qty || min);
  }

  updateSlideshow();
  updateModalPrice();

  modalAddCartBtn.onclick = () => {
    if (prod.stock <= 0) return;
    const qty = parseInt(document.getElementById('modal-qty-input')?.value, 10) || 1;
    const prodColors = getAvailableColors(prod);
    if (prodColors.length === 1 && !selectedColor) {
      selectedColor = prodColors[0];
    } else if (prodColors.length > 1 && !selectedColor) {
      showModalError('Please select a color before adding to cart.');
      return;
    }
    if (!selectedSize) {
      showModalError('Please select a size (L, XL, XXL or XXXL).');
      return;
    }
    if (!qty || qty < min) {
      showModalError(`Please choose at least ${min} piece${min > 1 ? 's' : ''}.`);
      return;
    }
    if (addToCart(prod.id, selectedSize, qty, selectedColor)) {
      closeModal();
      cartDrawer.classList.add('open');
      cartDrawerOverlay.classList.add('active');
    }
  };

  productModal.classList.add('active');
}

function updateSlideshow() {
  modalSlideshowImg.src = activeSlideshowImages[currentSlideIndex];
  slideCounter.textContent = `${currentSlideIndex + 1} / ${activeSlideshowImages.length}`;
}

document.getElementById('prev-slide')?.addEventListener('click', () => {
  currentSlideIndex = (currentSlideIndex - 1 + activeSlideshowImages.length) % activeSlideshowImages.length;
  updateSlideshow();
});

document.getElementById('next-slide')?.addEventListener('click', () => {
  currentSlideIndex = (currentSlideIndex + 1) % activeSlideshowImages.length;
  updateSlideshow();
});

function closeModal() {
  productModal.classList.remove('active');
  hideModalError();
}
document.getElementById('close-modal')?.addEventListener('click', closeModal);
productModal?.addEventListener('click', (e) => {
  if (e.target === productModal) closeModal();
});

function renderSizePicker(containerId = 'size-picker') {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  SIZES.forEach((size) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'size-btn' + (size === selectedSize ? ' active' : '');
    btn.textContent = size;
    btn.addEventListener('click', () => {
      selectedSize = size;
      renderSizePicker(containerId);
      hideModalError();
    });
    box.appendChild(btn);
  });
}

// Hook up modal quantity buttons
document.getElementById('modal-qty-minus')?.addEventListener('click', () => {
  const input = document.getElementById('modal-qty-input');
  if (!input) return;
  input.value = String(Math.max((parseInt(input.value, 10) || 1) - 1, parseInt(input.min, 10) || 1));
  updateModalPrice();
});
document.getElementById('modal-qty-plus')?.addEventListener('click', () => {
  const input = document.getElementById('modal-qty-input');
  if (!input) return;
  input.value = String((parseInt(input.value, 10) || 0) + 1);
  updateModalPrice();
});
document.getElementById('modal-qty-input')?.addEventListener('input', updateModalPrice);

// Alias openSizeDialog to openModal for seamless compatibility
function openSizeDialog(prod, opts = {}) {
  openModal(prod, opts);
}
function closeSizeDialog() {
  closeModal();
}

// Same product in a different size or color becomes its own cart line
function addToCart(productId, size, qty = 1, color = '') {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return false;
  qty = Math.max(parseInt(qty, 10) || 1, 1);

  const left = Number(prod.stock) - productQty(productId);
  if (qty > left) {
    alert(left > 0 ? `Only ${left} more of this item available.` : 'Maximum available stock reached.');
    return false;
  }

  const existing = cart.find((i) => i.id === productId && i.size === size && (i.color || '') === (color || ''));
  if (existing) existing.qty += qty;
  else {
    cart.push({
      id: prod.id, size, color: color || '', qty, name: prod.name, img: getImages(prod)[0],
      price: Number(prod.price),
      wsPrice: Number(prod.wholesale_price) > 0 ? Number(prod.wholesale_price) : 0,
      wsMin: wsMinOf(prod)
    });
  }
  updateCartUI();
  openCartDrawer();
  return true;
}

function changeQty(item, delta) {
  const prod = products.find((p) => p.id === item.id);
  const next = item.qty + delta;
  if (next <= 0) {
    cart = cart.filter((c) => !(c.id === item.id && c.size === item.size && (c.color || '') === (item.color || '')));
  } else {
    if (delta > 0 && prod && productQty(item.id) + delta > Number(prod.stock)) return alert('Maximum available stock reached.');
    item.qty = next;
  }
  updateCartUI();
}

function cartRow(item) {
  const unit = unitPrice(item);
  const row = document.createElement('div');
  row.className = 'cart-item-row';
  let hint = '';
  if (Number(item.wsPrice) > 0 && !isWholesaleLine(item)) {
    const need = wsMinOf(item) - productQty(item.id);
    if (need > 0) hint = `<div class="cart-hint">Add ${need} more (any size) for GHS ${Number(item.wsPrice).toFixed(2)} each</div>`;
  }
  row.innerHTML = `
    <img src="${escapeHtml(item.img)}" alt="${escapeHtml(item.name)}">
    <div class="cart-item-details">
      <h4>${escapeHtml(item.name)}</h4>
      <div class="cart-item-size">Size: ${escapeHtml(item.size)}${item.color ? ' · Color: ' + escapeHtml(item.color) : ''}</div>
      <div class="cart-item-price">GHS ${unit.toFixed(2)} each${isWholesaleLine(item) ? ' <span class="ws-tag">Wholesale</span>' : ''}</div>
      <div class="cart-qty">
        <button type="button" data-d="-1" aria-label="Less">−</button>
        <span>${item.qty}</span>
        <button type="button" data-d="1" aria-label="More">+</button>
        <b>GHS ${(unit * item.qty).toFixed(2)}</b>
      </div>
      ${hint}
    </div>
    <button class="remove-cart-item" aria-label="Remove">&times;</button>
  `;
  row.querySelectorAll('.cart-qty button').forEach((b) => b.addEventListener('click', () => changeQty(item, Number(b.dataset.d))));
  row.querySelector('.remove-cart-item').addEventListener('click', () => {
    cart = cart.filter((c) => !(c.id === item.id && c.size === item.size && (c.color || '') === (item.color || '')));
    updateCartUI();
  });
  return row;
}

function updateCartUI() {
  cartBadge.textContent = cart.reduce((acc, item) => acc + Number(item.qty), 0);
  cartItemsContainer.innerHTML = '';

  if (cart.length === 0) {
    cartItemsContainer.innerHTML = '<p class="cart-empty">Your shopping bag is empty.</p>';
  } else {
    const groups = [
      ['Wholesale price (3+ pieces)', cart.filter(isWholesaleLine)],
      ['Regular price', cart.filter((i) => !isWholesaleLine(i))]
    ];
    groups.forEach(([title, items]) => {
      if (!items.length) return;
      const h = document.createElement('div');
      h.className = 'cart-group-title';
      h.textContent = title;
      cartItemsContainer.appendChild(h);
      items.forEach((item) => cartItemsContainer.appendChild(cartRow(item)));
    });
  }

  const total = cart.reduce((s, i) => s + unitPrice(i) * Number(i.qty), 0);
  cartTotalPrice.textContent = `GHS ${total.toFixed(2)}`;
  saveCarts();
}

function openCartDrawer() {
  cartDrawer.classList.add('open');
  cartDrawerOverlay.classList.add('active');
}
function closeCartDrawer() {
  cartDrawer.classList.remove('open');
  cartDrawerOverlay.classList.remove('active');
}

document.getElementById('cart-drawer-btn')?.addEventListener('click', openCartDrawer);
document.getElementById('close-cart-drawer')?.addEventListener('click', closeCartDrawer);
cartDrawerOverlay?.addEventListener('click', closeCartDrawer);

document.getElementById('checkout-btn')?.addEventListener('click', () => {
  if (cart.length === 0) return alert('Your cart is empty!');
  saveCarts();
  window.location.href = 'checkout.html';
});

// ---------- Page switching: Home (shop) vs Wholesale ----------
function route() {
  const isWholesale = location.hash === '#wholesale';
  const home = document.getElementById('home-view');
  const wholesale = document.getElementById('wholesale');
  if (!home || !wholesale) return;

  home.style.display = isWholesale ? 'none' : '';
  wholesale.style.display = isWholesale ? '' : 'none';
  document.querySelectorAll('.nav-links a').forEach((link) => {
    link.classList.toggle('active', isWholesale && link.getAttribute('href') === '#wholesale');
  });

  if (isWholesale) {
    window.scrollTo(0, 0);
  } else {
    window.dispatchEvent(new Event('resize')); // fixes the 3D hero size after being hidden
    const target = document.getElementById(location.hash.slice(1));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }
}
window.addEventListener('hashchange', route);

document.addEventListener('DOMContentLoaded', () => {
  clearLegacyCartKeys();
  loadCartsFor('guest');
  updateCartUI();
  init3DHero();
  route();
  renderChips();
  bindSearch();
  loadProducts();
  loadCategories();
});