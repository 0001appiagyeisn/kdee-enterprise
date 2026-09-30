import { supabase, WHATSAPP_NUMBER } from './supabase-config.js';

let products = [];
let cart = [];
let activeSlideshowImages = [];
let currentSlideIndex = 0;

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

  // Supabase Realtime Subscription
  supabase
    .channel('public:products')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
      loadProducts();
    })
    .subscribe();
}

function renderProducts() {
  if (!productGrid) return;
  productGrid.innerHTML = '';

  products.forEach(prod => {
    const images = prod.images && prod.images.length > 0 ? prod.images : (prod.image_url ? [prod.image_url] : ['https://via.placeholder.com/300']);
    const primaryImg = images[0];
    const isOutOfStock = Number(prod.stock) <= 0;

    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="product-img-wrapper">
        <img src="${primaryImg}" alt="${prod.name}">
        ${isOutOfStock ? '<span class="badge out-of-stock">Out of Stock</span>' : '<span class="badge">New</span>'}
      </div>
      <div class="product-info">
        <div>
          <h3>${prod.name}</h3>
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
        addToCart(prod.id);
      });
    }

    productGrid.appendChild(card);
  });
}

function openModal(prod) {
  activeSlideshowImages = prod.images && prod.images.length > 0 ? prod.images : (prod.image_url ? [prod.image_url] : ['https://via.placeholder.com/400']);
  currentSlideIndex = 0;

  modalTitle.textContent = prod.name;
  modalPrice.textContent = `GHS ${Number(prod.price).toFixed(2)}`;
  modalStock.textContent = prod.stock > 0 ? `In Stock (${prod.stock} left)` : 'Out of Stock';
  modalDescription.textContent = prod.description || 'No description provided.';

  modalAddCartBtn.disabled = prod.stock <= 0;
  modalAddCartBtn.textContent = prod.stock > 0 ? 'Add To Cart' : 'Sold Out';

  updateSlideshow();

  modalAddCartBtn.onclick = () => {
    if (prod.stock > 0) {
      addToCart(prod.id);
      closeModal();
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
}
document.getElementById('close-modal')?.addEventListener('click', closeModal);

function addToCart(productId) {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;

  const primaryImg = (prod.images && prod.images[0]) || prod.image_url || 'https://via.placeholder.com/100';

  const existing = cart.find(item => item.id === productId);
  if (existing) {
    if (existing.qty < prod.stock) existing.qty++;
    else alert('Maximum available stock reached.');
  } else {
    cart.push({ id: prod.id, name: prod.name, price: Number(prod.price), img: primaryImg, qty: 1 });
  }

  updateCartUI();
  openCartDrawer();
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
      <img src="${item.img}" alt="${item.name}">
      <div class="cart-item-details">
        <h4>${item.name}</h4>
        <div class="cart-item-price">GHS ${item.price.toFixed(2)} x ${item.qty}</div>
      </div>
      <button class="remove-cart-item">&times;</button>
    `;

    row.querySelector('.remove-cart-item').addEventListener('click', () => {
      cart = cart.filter(c => c.id !== item.id);
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
  const address = document.getElementById('cust-address').value.trim();

  if (cart.length === 0) return alert('Your cart is empty!');
  if (!name || !address) return alert('Please fill in your name and address!');

  let orderMessage = `*New Order - KDee Enterprise*\n\n`;
  orderMessage += `*Customer:* ${name}\n`;
  orderMessage += `*Location:* ${address}\n\n`;
  orderMessage += `*Items Ordered:*\n`;

  let grandTotal = 0;
  cart.forEach((item, index) => {
    const sum = item.price * item.qty;
    grandTotal += sum;
    orderMessage += `${index + 1}. ${item.name} (${item.qty}x) - GHS ${sum.toFixed(2)}\n`;
  });

  orderMessage += `\n*Total Amount:* GHS ${grandTotal.toFixed(2)}`;

  const encodedMsg = encodeURIComponent(orderMessage);
  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodedMsg}`, '_blank');
});

document.addEventListener('DOMContentLoaded', () => {
  init3DHero();
  loadProducts();
});