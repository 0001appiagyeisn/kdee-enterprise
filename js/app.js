import { supabase, WHATSAPP_NUMBER } from './supabase-config.js';

let products = [];
let cart = [];
let activeSlideshowImages = [];
let currentSlideIndex = 0;
let realtimeStarted = false;
let activeCategory = 'all';
let searchTerm = '';
let wholesaleCart = [];
let selectedSize = '';
const SIZES = ['L', 'XL', 'XXL', 'XXXL'];
const isValidPhone = (p) => /^\+?[\d\s-]{9,15}$/.test(p) && p.replace(/\D/g, '').length >= 9;

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'casual', label: 'Casual' },
  { key: 'official', label: 'Official' },
  { key: 'jeans', label: 'Jeans' },
  { key: 'shirts', label: 'Shirts' },
  { key: 'tshirts', label: 'T-Shirts' },
  { key: 'shorts', label: 'Shorts' },
  { key: 'trousers', label: 'Trousers' },
  { key: 'jackets', label: 'Jackets' },
  { key: 'accessories', label: 'Accessories' }
];
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
    document.getElementById('new-arrivals')?.scrollIntoView({ behavior: 'smooth' });
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
    productGrid.innerHTML = '<p class="no-results">No products found. Try another category or search.</p>';
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
const wsMinQty = (p) => Math.max(parseInt(p.wholesale_min_qty, 10) || 10, 1);

function renderWholesale() {
  const grid = document.getElementById('wholesale-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const list = products.filter((p) => Number(p.wholesale_price) > 0);
  if (list.length === 0) {
    grid.innerHTML = '<p class="no-results">Wholesale items will be listed here soon. Message us on WhatsApp for bulk prices.</p>';
    return;
  }

  list.forEach((prod) => {
    const min = wsMinQty(prod);
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
          <div class="ws-min">Minimum order: ${min} pcs &middot; ${stock} in stock</div>
        </div>
        <div class="ws-controls">
          <input type="number" class="ws-qty" min="${min}" max="${stock}" value="${min}" ${canOrder ? '' : 'disabled'}>
          <button class="btn btn-primary ws-add" ${canOrder ? '' : 'disabled'}>${canOrder ? 'Add To Bulk Order' : 'Low Stock'}</button>
        </div>
      </div>
    `;

    card.querySelector('.ws-add').addEventListener('click', () => {
      addToWholesale(prod, parseInt(card.querySelector('.ws-qty').value, 10));
    });
    grid.appendChild(card);
  });
}

function addToWholesale(prod, qty) {
  const min = wsMinQty(prod);
  const stock = Number(prod.stock) || 0;
  if (!qty || qty < min) return alert(`Minimum wholesale order for this item is ${min} pieces.`);

  const existing = wholesaleCart.find((i) => i.id === prod.id);
  const newQty = (existing ? existing.qty : 0) + qty;
  if (newQty > stock) return alert(`Only ${stock} pieces are available in stock.`);

  if (existing) existing.qty = newQty;
  else wholesaleCart.push({ id: prod.id, name: prod.name, price: Number(prod.wholesale_price), img: getImages(prod)[0], qty: newQty });

  updateWholesaleUI();
  document.querySelector('.ws-order')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateWholesaleUI() {
  const box = document.getElementById('ws-order-items');
  const totalEl = document.getElementById('ws-total');
  if (!box || !totalEl) return;
  box.innerHTML = '';

  if (wholesaleCart.length === 0) {
    box.innerHTML = '<p class="ws-empty">No items yet. Add wholesale items above.</p>';
    totalEl.textContent = 'GHS 0.00';
    return;
  }

  let total = 0;
  wholesaleCart.forEach((item) => {
    const sum = item.price * item.qty;
    total += sum;
    const row = document.createElement('div');
    row.className = 'cart-item-row';
    row.innerHTML = `
      <img src="${escapeHtml(item.img)}" alt="${escapeHtml(item.name)}">
      <div class="cart-item-details">
        <h4>${escapeHtml(item.name)}</h4>
        <div class="cart-item-price">GHS ${item.price.toFixed(2)} x ${item.qty} = GHS ${sum.toFixed(2)}</div>
      </div>
      <button class="remove-cart-item">&times;</button>
    `;
    row.querySelector('.remove-cart-item').addEventListener('click', () => {
      wholesaleCart = wholesaleCart.filter((c) => c.id !== item.id);
      updateWholesaleUI();
    });
    box.appendChild(row);
  });
  totalEl.textContent = `GHS ${total.toFixed(2)}`;
}

document.getElementById('ws-checkout-btn')?.addEventListener('click', () => {
  const name = document.getElementById('ws-name').value.trim();
  const address = document.getElementById('ws-address').value.trim();
  const phone = document.getElementById('ws-phone').value.trim();
  const sizes = document.getElementById('ws-sizes').value.trim();

  if (wholesaleCart.length === 0) return alert('Your bulk order is empty!');
  if (!name || !address) return alert('Please fill in your name and delivery location!');
  if (!isValidPhone(phone)) return alert('Please enter a valid phone number.');

  let msg = `*New WHOLESALE Order - KD Wisdom Enterprise*\n\n`;
  msg += `*Customer:* ${name}\n*Phone:* ${phone}\n*Location:* ${address}\n`;
  if (sizes) msg += `*Sizes needed:* ${sizes}\n`;
  msg += `\n*Items Ordered:*\n`;

  let grand = 0;
  wholesaleCart.forEach((item, idx) => {
    const sum = item.price * item.qty;
    grand += sum;
    msg += `${idx + 1}. ${item.name} (${item.qty} pcs @ GHS ${item.price.toFixed(2)}) - GHS ${sum.toFixed(2)}\n`;
  });
  msg += `\n*Total Amount:* GHS ${grand.toFixed(2)}`;

  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank');
});

function openModal(prod) {
  activeSlideshowImages = prod.images && prod.images.length > 0 ? prod.images : (prod.image_url ? [prod.image_url] : ['https://via.placeholder.com/400']);
  currentSlideIndex = 0;

  modalTitle.textContent = prod.name;
  modalPrice.textContent = `GHS ${Number(prod.price).toFixed(2)}`;
  modalStock.textContent = prod.stock > 0 ? `In Stock (${prod.stock} left)` : 'Out of Stock';
  modalDescription.textContent = prod.description || 'No description provided.';

  modalAddCartBtn.disabled = prod.stock <= 0;
  modalAddCartBtn.textContent = prod.stock > 0 ? 'Add To Cart' : 'Sold Out';

  selectedSize = '';
  renderSizePicker();
  updateSlideshow();

  modalAddCartBtn.onclick = () => {
    if (prod.stock <= 0) return;
    if (!selectedSize) return alert('Please select a size (L, XL, XXL or XXXL).');
    if (addToCart(prod.id, selectedSize)) closeModal();
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
}
document.getElementById('close-modal')?.addEventListener('click', closeModal);

function renderSizePicker(containerId = 'size-picker') {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  SIZES.forEach((size) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'size-btn' + (size === selectedSize ? ' active' : '');
    btn.textContent = size;
    btn.addEventListener('click', () => { selectedSize = size; renderSizePicker(containerId); });
    box.appendChild(btn);
  });
}

// Step 2 of ordering: pick a size, then add to cart
const sizeDialog = document.getElementById('size-dialog');

function openSizeDialog(prod) {
  selectedSize = '';
  document.getElementById('size-dialog-img').src = getImages(prod)[0];
  document.getElementById('size-dialog-name').textContent = prod.name;
  document.getElementById('size-dialog-price').textContent = `GHS ${Number(prod.price).toFixed(2)}`;
  renderSizePicker('size-dialog-picker');

  document.getElementById('size-dialog-add').onclick = () => {
    if (!selectedSize) return alert('Please select a size (L, XL, XXL or XXXL).');
    if (addToCart(prod.id, selectedSize)) closeSizeDialog();
  };

  sizeDialog.classList.add('active');
}

function closeSizeDialog() {
  sizeDialog.classList.remove('active');
}
document.getElementById('close-size-dialog')?.addEventListener('click', closeSizeDialog);
sizeDialog?.addEventListener('click', (e) => { if (e.target === sizeDialog) closeSizeDialog(); });

// Same product in a different size becomes its own cart line
function addToCart(productId, size) {
  const prod = products.find(p => p.id === productId);
  if (!prod) return false;

  const primaryImg = (prod.images && prod.images[0]) || prod.image_url || 'https://via.placeholder.com/100';

  const inCart = cart.filter(i => i.id === productId).reduce((sum, i) => sum + i.qty, 0);
  if (inCart >= Number(prod.stock)) {
    alert('Maximum available stock reached.');
    return false;
  }

  const existing = cart.find(i => i.id === productId && i.size === size);
  if (existing) existing.qty++;
  else cart.push({ id: prod.id, size, name: prod.name, price: Number(prod.price), img: primaryImg, qty: 1 });

  updateCartUI();
  openCartDrawer();
  return true;
}

function updateCartUI() {
  cartBadge.textContent = cart.reduce((acc, item) => acc + item.qty, 0);
  cartItemsContainer.innerHTML = '';

  let total = 0;
  cart.forEach(item => {
    const itemTotal = item.price * item.qty;
    total += itemTotal;

    const row = document.createElement('div');
    row.className = 'cart-item-row';
    row.innerHTML = `
      <img src="${escapeHtml(item.img)}" alt="${escapeHtml(item.name)}">
      <div class="cart-item-details">
        <h4>${escapeHtml(item.name)}</h4>
        <div class="cart-item-size">Size: ${item.size}</div>
        <div class="cart-item-price">GHS ${item.price.toFixed(2)} x ${item.qty}</div>
      </div>
      <button class="remove-cart-item">&times;</button>
    `;

    row.querySelector('.remove-cart-item').addEventListener('click', () => {
      cart = cart.filter(c => !(c.id === item.id && c.size === item.size));
      updateCartUI();
    });

    cartItemsContainer.appendChild(row);
  });

  cartTotalPrice.textContent = `GHS ${total.toFixed(2)}`;
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

document.getElementById('whatsapp-checkout-btn')?.addEventListener('click', () => {
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const address = document.getElementById('cust-address').value.trim();

  if (cart.length === 0) return alert('Your cart is empty!');
  if (!name || !address) return alert('Please fill in your name and address!');
  if (!isValidPhone(phone)) return alert('Please enter a valid phone number.');

  let orderMessage = `*New Order - KD Wisdom Enterprise*\n\n`;
  orderMessage += `*Customer:* ${name}\n`;
  orderMessage += `*Phone:* ${phone}\n`;
  orderMessage += `*Location:* ${address}\n\n`;
  orderMessage += `*Items Ordered:*\n`;

  let grandTotal = 0;
  cart.forEach((item, index) => {
    const sum = item.price * item.qty;
    grandTotal += sum;
    orderMessage += `${index + 1}. ${item.name} - Size ${item.size} (${item.qty}x) - GHS ${sum.toFixed(2)}\n`;
  });

  orderMessage += `\n*Total Amount:* GHS ${grandTotal.toFixed(2)}`;

  const encodedMsg = encodeURIComponent(orderMessage);
  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodedMsg}`, '_blank');
});

document.addEventListener('DOMContentLoaded', () => {
  init3DHero();
  renderChips();
  bindSearch();
  updateWholesaleUI();
  loadProducts();
});