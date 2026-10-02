import { supabase } from './supabase-config.js';

const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const productForm = document.getElementById('add-product-form');
const adminInventoryList = document.getElementById('admin-inventory-list');

// Bulk select elements
const selectAllBox = document.getElementById('select-all');
const selectedCountEl = document.getElementById('selected-count');
const bulkDeleteBtn = document.getElementById('bulk-delete-btn');

// Edit modal elements
const editOverlay = document.getElementById('edit-overlay');
const editForm = document.getElementById('edit-product-form');
const editImageManager = document.getElementById('e-image-manager');
const editImageInput = document.getElementById('e-image-file');
const editSaveBtn = document.getElementById('edit-save-btn');

// State
let allProducts = [];
const selectedIds = new Set();
let editingProduct = null;
let keptImages = [];   // existing image URLs still attached to the product
let newFiles = [];     // File objects queued for upload

const BUCKET = 'product-images';

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
let CATEGORIES = [...DEFAULT_CATEGORIES]; // replaced by the categories saved in Supabase
let categoriesReady = false;              // true once the categories table could be read
const normCat = (c) => (c === 'short_jeans' ? 'shorts' : (c || ''));
const catLabel = (c) => (CATEGORIES.find((x) => x.key === normCat(c)) || {}).label || 'No category';

// Blank wholesale price = item not offered wholesale
function readWholesale(priceId, minId) {
  const price = parseFloat(document.getElementById(priceId).value);
  const min = parseInt(document.getElementById(minId).value, 10);
  if (isNaN(price) || price <= 0) return { wholesale_price: null, wholesale_min_qty: null };
  return { wholesale_price: price, wholesale_min_qty: (isNaN(min) || min < 1) ? 10 : min };
}

// ---------- Helpers ----------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function getImages(prod) {
  if (prod.images && prod.images.length > 0) return prod.images;
  if (prod.image_url) return [prod.image_url];
  return [];
}

function formatGHS(n) {
  return 'GHS ' + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Image compression (keeps storage & bandwidth small) ----------
async function compressImage(file, maxSize = 1280, quality = 0.82) {
  try {
    if (!file.type || !file.type.startsWith('image/')) return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob || (scale === 1 && blob.size >= file.size)) return file;
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch (e) {
    console.warn('Compression skipped:', e);
    return file;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

// ---------- AI product helper (calls the secure Supabase Edge Function) ----------
async function aiSuggest(fileOrBlob) {
  const small = await compressImage(fileOrBlob, 768, 0.7);
  const image = await blobToBase64(small);
  const { data, error } = await supabase.functions.invoke('analyze-product', {
    body: { image, mimeType: small.type || 'image/jpeg', categories: CATEGORIES.map(({ key, label }) => ({ key, label })) }
  });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function applyAiResult(prefix, result, force) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && value && (force || !el.value.trim())) el.value = value;
  };
  set(`${prefix}-name`, result.name);
  set(`${prefix}-category`, result.category);
  set(prefix === 'p' ? 'p-desc' : 'e-desc', result.description);
}

// Uploads a single file to Supabase storage, returns public URL (or throws)
async function uploadImage(file) {
  file = await compressImage(file);
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}_${file.name.replace(/\s+/g, '_')}`;
  const { error } = await supabase.storage.from(BUCKET).upload(fileName, file);
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

// Best-effort removal of images from storage (never blocks the main action)
async function removeFromStorage(urls) {
  const marker = `/${BUCKET}/`;
  const paths = urls
    .filter((u) => typeof u === 'string' && u.includes(marker))
    .map((u) => decodeURIComponent(u.split(marker)[1].split('?')[0]));
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch (e) {
    console.warn('Storage cleanup failed (non-fatal):', e);
  }
}

// 1. Session & Auth Gate
const SESSION_HOURS = 24; // admin must log in again after this many hours
const LOGIN_TIME_KEY = 'kd_admin_login_at';

function sessionExpired() {
  const at = Number(localStorage.getItem(LOGIN_TIME_KEY));
  return !at || Date.now() - at > SESSION_HOURS * 60 * 60 * 1000;
}

function showAuthMessage(text) {
  const el = document.getElementById('auth-msg');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

async function checkAuth(message) {
  let { data: { session } } = await supabase.auth.getSession();
  if (session && sessionExpired()) {
    await supabase.auth.signOut();
    localStorage.removeItem(LOGIN_TIME_KEY);
    session = null;
    message = message || 'Your session has expired. Please log in again.';
  }
  showAuthMessage(typeof message === 'string' ? message : '');
  if (session) {
    if (authOverlay) authOverlay.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
  } else {
    if (authOverlay) authOverlay.style.display = 'flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
  loadAdminInventory();
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-password').value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      alert('Login failed: ' + error.message);
    } else {
      localStorage.setItem(LOGIN_TIME_KEY, String(Date.now()));
      checkAuth();
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    localStorage.removeItem(LOGIN_TIME_KEY);
    checkAuth();
  });
}

// 2. Dashboard Stats
function updateDashboard() {
  const totalProducts = allProducts.length;
  const totalUnits = allProducts.reduce((sum, p) => sum + Math.max(Number(p.stock) || 0, 0), 0);
  const inventoryValue = allProducts.reduce(
    (sum, p) => sum + (Number(p.price) || 0) * Math.max(Number(p.stock) || 0, 0), 0
  );
  const outOfStock = allProducts.filter((p) => (Number(p.stock) || 0) <= 0).length;

  document.getElementById('stat-total-products').textContent = totalProducts.toLocaleString();
  document.getElementById('stat-total-units').textContent = totalUnits.toLocaleString();
  document.getElementById('stat-inventory-value').textContent = formatGHS(inventoryValue);
  document.getElementById('stat-out-of-stock').textContent = outOfStock.toLocaleString();
}

// 3. Categories (saved in Supabase so you can add/remove them without touching code)
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 30);

function renderCategoryManager() {
  const list = document.getElementById('category-list');
  const hint = document.getElementById('category-hint');
  if (!list) return;
  list.innerHTML = '';
  CATEGORIES.forEach((cat) => {
    const count = allProducts.filter((p) => normCat(p.category) === cat.key).length;
    const pill = document.createElement('span');
    pill.className = 'cat-pill';
    pill.innerHTML = `${escapeHtml(cat.label)} <small>(${count})</small>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Delete category';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => deleteCategory(cat));
    pill.appendChild(del);
    list.appendChild(pill);
  });
  if (hint) {
    hint.textContent = categoriesReady
      ? 'Changes show on the shop right away. Deleting a category does not delete its products.'
      : '⚠️ Categories table not found. Run database-update-2.sql in Supabase to add or remove categories.';
  }
}

function fillCategoryControls() {
  ['p-category', 'e-category'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">Select category</option>' +
      CATEGORIES.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('');
    el.value = current;
  });

  if (invCategoryEl) {
    invCategoryEl.innerHTML = '<option value="all">All categories</option>' +
      CATEGORIES.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('') +
      '<option value="__none__">No category</option>';
    invCategoryEl.value = invCategory;
    if (invCategoryEl.value !== invCategory) { invCategory = 'all'; invCategoryEl.value = 'all'; }
  }
  renderCategoryManager();
}

async function loadCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order', { ascending: true });

  categoriesReady = !error && Array.isArray(data);
  CATEGORIES = categoriesReady
    ? data.map((c) => ({ key: c.key, label: c.label, sort_order: c.sort_order }))
    : [...DEFAULT_CATEGORIES];

  fillCategoryControls();
  renderInventory();
}

async function addCategory() {
  const input = document.getElementById('new-category');
  const label = input.value.trim().replace(/\s+/g, ' ');
  if (!label) return;
  if (!categoriesReady) return alert('Run database-update-2.sql in Supabase first, then refresh this page.');

  const key = slugify(label);
  if (!key) return alert('Please use letters or numbers in the category name.');
  if (CATEGORIES.some((c) => c.key === key || c.label.toLowerCase() === label.toLowerCase())) {
    return alert('That category already exists.');
  }

  const sort_order = Math.max(0, ...CATEGORIES.map((c) => c.sort_order || 0)) + 1;
  const { error } = await supabase.from('categories').insert([{ key, label, sort_order }]);
  if (error) return alert('Could not add category: ' + error.message);

  input.value = '';
  loadCategories();
}

async function deleteCategory(cat) {
  if (!categoriesReady) return alert('Run database-update-2.sql in Supabase first.');
  const keys = cat.key === 'shorts' ? ['shorts', 'short_jeans'] : [cat.key];
  const used = allProducts.filter((p) => keys.includes(p.category)).length;
  const msg = used > 0
    ? `Delete "${cat.label}"? ${used} product(s) use it and will become "No category". They stay in your shop and still show under All.`
    : `Delete "${cat.label}"?`;
  if (!confirm(msg)) return;

  if (used > 0) {
    const { error: moveError } = await supabase.from('products').update({ category: null }).in('category', keys);
    if (moveError) return alert('Could not update products: ' + moveError.message);
  }
  const { error } = await supabase.from('categories').delete().eq('key', cat.key);
  if (error) return alert('Could not delete category: ' + error.message);

  await loadAdminInventory();
  loadCategories();
}

document.getElementById('add-category-btn')?.addEventListener('click', addCategory);
document.getElementById('new-category')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
});

// 4. Inventory view: search, filter by category, sort
const invSearchEl = document.getElementById('inv-search');
const invCategoryEl = document.getElementById('inv-category');
const invSortEl = document.getElementById('inv-sort');
const invCountEl = document.getElementById('inv-count');
let invSearch = '';
let invCategory = 'all';
let invSort = 'newest';
let visibleProducts = [];

function matchesSearch(p, term) {
  if (!term) return true;
  const price = Number(p.price) || 0;

  // Price range, e.g. "100-200"
  const range = term.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (range) {
    const lo = Math.min(parseFloat(range[1]), parseFloat(range[2]));
    const hi = Math.max(parseFloat(range[1]), parseFloat(range[2]));
    return price >= lo && price <= hi;
  }

  const text = [p.name, p.description, catLabel(p.category)].join(' ').toLowerCase();
  if (text.includes(term)) return true;

  // Plain number, e.g. "150" matches prices starting with 150 (retail or wholesale)
  if (/^\d+(\.\d+)?$/.test(term)) {
    return [price, Number(p.wholesale_price) || 0].some((v) => v > 0 && String(v).startsWith(term));
  }
  return false;
}

function getVisibleProducts() {
  const term = invSearch.trim().toLowerCase();

  let list = allProducts.filter((p) => {
    const cat = normCat(p.category);
    if (invCategory === '__none__') { if (CATEGORIES.some((c) => c.key === cat)) return false; }
    else if (invCategory !== 'all' && cat !== invCategory) return false;
    return matchesSearch(p, term);
  });

  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const num = (v) => Number(v) || 0;
  list = [...list];
  if (invSort === 'name') list.sort(byName);
  else if (invSort === 'category') list.sort((a, b) => catLabel(a.category).localeCompare(catLabel(b.category)) || byName(a, b));
  else if (invSort === 'price-asc') list.sort((a, b) => num(a.price) - num(b.price));
  else if (invSort === 'price-desc') list.sort((a, b) => num(b.price) - num(a.price));
  else if (invSort === 'stock-asc') list.sort((a, b) => num(a.stock) - num(b.stock));
  else if (invSort === 'stock-desc') list.sort((a, b) => num(b.stock) - num(a.stock));
  return list; // "newest" keeps the order from the database
}

invSearchEl?.addEventListener('input', () => { invSearch = invSearchEl.value; renderInventory(); });
invCategoryEl?.addEventListener('change', () => { invCategory = invCategoryEl.value; renderInventory(); });
invSortEl?.addEventListener('change', () => { invSort = invSortEl.value; renderInventory(); });

// 5. Bulk selection UI (works on the items currently shown)
function updateBulkUI() {
  const count = selectedIds.size;
  const shownSelected = visibleProducts.filter((p) => selectedIds.has(p.id)).length;
  selectedCountEl.textContent = `${count} selected`;
  bulkDeleteBtn.disabled = count === 0;
  selectAllBox.checked = visibleProducts.length > 0 && shownSelected === visibleProducts.length;
  selectAllBox.indeterminate = shownSelected > 0 && shownSelected < visibleProducts.length;
}

if (selectAllBox) {
  selectAllBox.addEventListener('change', () => {
    if (selectAllBox.checked) visibleProducts.forEach((p) => selectedIds.add(p.id));
    else visibleProducts.forEach((p) => selectedIds.delete(p.id));
    document.querySelectorAll('.stock-row').forEach((row) => {
      row.querySelector('.row-check').checked = selectAllBox.checked;
      row.classList.toggle('selected', selectAllBox.checked);
    });
    updateBulkUI();
  });
}

if (bulkDeleteBtn) {
  bulkDeleteBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected item(s)? This cannot be undone.`)) return;

    const toDelete = allProducts.filter((p) => selectedIds.has(p.id));
    const imagesToRemove = toDelete.flatMap(getImages);

    bulkDeleteBtn.disabled = true;
    const { error } = await supabase.from('products').delete().in('id', ids);

    if (error) {
      alert('Bulk delete failed: ' + error.message);
      updateBulkUI();
      return;
    }

    removeFromStorage(imagesToRemove);
    selectedIds.clear();
    loadAdminInventory();
  });
}

// 6. Load + draw inventory
async function loadAdminInventory() {
  if (!adminInventoryList) return;

  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching inventory:', error);
    return;
  }

  allProducts = products || [];
  renderInventory();
  renderCategoryManager();
}

function renderInventory() {
  if (!adminInventoryList) return;

  visibleProducts = getVisibleProducts();

  // Only items you can see stay selected, so a bulk delete never touches hidden items
  const shownIds = new Set(visibleProducts.map((p) => p.id));
  [...selectedIds].forEach((id) => { if (!shownIds.has(id)) selectedIds.delete(id); });

  const scrollTop = adminInventoryList.scrollTop;
  adminInventoryList.innerHTML = '';

  if (visibleProducts.length === 0) {
    adminInventoryList.innerHTML = '<p class="img-hint" style="text-align:center;padding:30px 0;">No products match your search or filter.</p>';
  }

  visibleProducts.forEach((prod) => {
    const images = getImages(prod);
    const firstImg = images[0] || 'https://via.placeholder.com/60';

    const row = document.createElement('div');
    row.className = 'stock-row' + (selectedIds.has(prod.id) ? ' selected' : '');
    row.innerHTML = `
      <input type="checkbox" class="row-check" ${selectedIds.has(prod.id) ? 'checked' : ''} title="Select">
      <img src="${escapeHtml(firstImg)}" alt="${escapeHtml(prod.name)}">
      <div class="stock-info">
        <h4>${escapeHtml(prod.name)}</h4>
        <p>GHS ${Number(prod.price).toFixed(2)} | Images: ${images.length} | ${escapeHtml(catLabel(prod.category))}${Number(prod.wholesale_price) > 0 ? ' | Wholesale: GHS ' + Number(prod.wholesale_price).toFixed(2) + ' (min ' + (prod.wholesale_min_qty || 10) + ')' : ''}</p>
      </div>
      <div class="stock-controls">
        <input type="number" value="${prod.stock ?? 0}" class="input-stock" title="Current Stock">
        <button class="btn-action btn-save" title="Save stock"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        <button class="btn-action btn-edit" title="Edit product"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn-action btn-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;

    row.querySelector('.row-check').addEventListener('change', (e) => {
      if (e.target.checked) selectedIds.add(prod.id);
      else selectedIds.delete(prod.id);
      row.classList.toggle('selected', e.target.checked);
      updateBulkUI();
    });

    row.querySelector('.btn-save').addEventListener('click', async () => {
      const newStock = parseInt(row.querySelector('.input-stock').value, 10);
      const { error: updateError } = await supabase.from('products').update({ stock: newStock }).eq('id', prod.id);
      if (updateError) alert('Update failed: ' + updateError.message);
      else {
        alert('Stock updated successfully!');
        loadAdminInventory();
      }
    });

    row.querySelector('.btn-edit').addEventListener('click', () => openEditModal(prod));

    row.querySelector('.btn-delete').addEventListener('click', async () => {
      if (confirm(`Delete "${prod.name}"?`)) {
        const { error: deleteError } = await supabase.from('products').delete().eq('id', prod.id);
        if (deleteError) alert('Delete failed: ' + deleteError.message);
        else {
          removeFromStorage(images);
          selectedIds.delete(prod.id);
          loadAdminInventory();
        }
      }
    });

    adminInventoryList.appendChild(row);
  });

  adminInventoryList.scrollTop = scrollTop;
  if (invCountEl) invCountEl.textContent = `Showing ${visibleProducts.length} of ${allProducts.length} products`;
  updateDashboard();
  updateBulkUI();
}

// 5. Edit Product Modal
function renderEditImages() {
  editImageManager.innerHTML = '';

  keptImages.forEach((url, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'img-thumb';
    thumb.innerHTML = `<img src="${escapeHtml(url)}" alt="Product image"><button type="button" class="remove-img" title="Remove">&times;</button>`;
    thumb.querySelector('.remove-img').addEventListener('click', () => {
      keptImages.splice(idx, 1);
      renderEditImages();
    });
    editImageManager.appendChild(thumb);
  });

  newFiles.forEach((file, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'img-thumb';
    const previewUrl = URL.createObjectURL(file);
    thumb.innerHTML = `<img src="${previewUrl}" alt="New image"><button type="button" class="remove-img" title="Remove">&times;</button><span class="new-tag">New</span>`;
    thumb.querySelector('.remove-img').addEventListener('click', () => {
      URL.revokeObjectURL(previewUrl);
      newFiles.splice(idx, 1);
      renderEditImages();
    });
    editImageManager.appendChild(thumb);
  });
}

function openEditModal(prod) {
  editingProduct = prod;
  keptImages = [...getImages(prod)];
  newFiles = [];

  document.getElementById('e-name').value = prod.name || '';
  document.getElementById('e-price').value = prod.price ?? '';
  document.getElementById('e-stock').value = prod.stock ?? 0;
  document.getElementById('e-desc').value = prod.description || '';
  document.getElementById('e-category').value = normCat(prod.category);
  document.getElementById('e-ws-price').value = prod.wholesale_price ?? '';
  document.getElementById('e-ws-min').value = prod.wholesale_min_qty ?? '';
  editImageInput.value = '';

  renderEditImages();
  editOverlay.classList.add('active');
}

function closeEditModal() {
  editOverlay.classList.remove('active');
  editingProduct = null;
  keptImages = [];
  newFiles = [];
  editImageInput.value = '';
}

document.getElementById('edit-close')?.addEventListener('click', closeEditModal);
document.getElementById('edit-cancel')?.addEventListener('click', closeEditModal);
editOverlay?.addEventListener('click', (e) => { if (e.target === editOverlay) closeEditModal(); });

editImageInput?.addEventListener('change', () => {
  newFiles.push(...Array.from(editImageInput.files));
  editImageInput.value = '';
  renderEditImages();
});

editForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingProduct) return;

  const name = document.getElementById('e-name').value.trim();
  const price = parseFloat(document.getElementById('e-price').value);
  const stock = parseInt(document.getElementById('e-stock').value, 10);
  const description = document.getElementById('e-desc').value.trim();
  const category = document.getElementById('e-category').value;
  const wholesale = readWholesale('e-ws-price', 'e-ws-min');

  if (!name || isNaN(price) || isNaN(stock)) {
    alert('Please provide a valid name, price and stock.');
    return;
  }
  if (keptImages.length + newFiles.length === 0) {
    alert('A product needs at least one image.');
    return;
  }

  editSaveBtn.disabled = true;
  editSaveBtn.textContent = 'Saving...';

  try {
    const uploadedUrls = [];
    for (const file of newFiles) {
      uploadedUrls.push(await uploadImage(file));
    }

    const finalImages = [...keptImages, ...uploadedUrls];
    const removedImages = getImages(editingProduct).filter((u) => !keptImages.includes(u));

    const { error } = await supabase
      .from('products')
      .update({
        name,
        price,
        stock,
        description,
        category,
        ...wholesale,
        images: finalImages,
        image_url: finalImages[0]
      })
      .eq('id', editingProduct.id);

    if (error) throw new Error(error.message);

    removeFromStorage(removedImages);
    closeEditModal();
    loadAdminInventory();
    alert('Product updated successfully!');
  } catch (err) {
    alert('Update failed: ' + err.message);
  } finally {
    editSaveBtn.disabled = false;
    editSaveBtn.textContent = 'Save Changes';
  }
});

// 6. Handle Multi-Image Product Submission
if (productForm) {
  productForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('p-name').value.trim();
    const price = parseFloat(document.getElementById('p-price').value);
    const stock = parseInt(document.getElementById('p-stock').value, 10);
    const description = document.getElementById('p-desc').value.trim();
    const category = document.getElementById('p-category').value;
    const wholesale = readWholesale('p-ws-price', 'p-ws-min');
    const fileInput = document.getElementById('p-image-file');
    const files = pendingFiles;

    if (files.length === 0) {
      alert('Please select at least one product image.');
      return;
    }

    const uploadBtn = document.getElementById('upload-btn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';

    const imageUrls = [];

    for (let i = 0; i < files.length; i++) {
      const file = await compressImage(files[i]);
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}_${file.name.replace(/\s+/g, '_')}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('product-images')
        .upload(fileName, file);

      if (uploadError) {
        alert('Image Upload Failed: ' + uploadError.message);
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload To Store';
        return;
      }

      const { data: publicUrlData } = supabase.storage
        .from('product-images')
        .getPublicUrl(fileName);

      imageUrls.push(publicUrlData.publicUrl);
    }

    const { error: insertError } = await supabase
      .from('products')
      .insert([{
        name,
        price,
        stock,
        description,
        category,
        ...wholesale,
        images: imageUrls,
        image_url: imageUrls[0]
      }]);

    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload To Store';

    if (insertError) {
      alert('Failed to insert product: ' + insertError.message);
    } else {
      alert('Product uploaded successfully!');
      productForm.reset();
      pendingFiles = [];
      renderPendingImages();
      if (aiStatus) aiStatus.textContent = '';
      loadAdminInventory();
    }
  });
}

// 7a. Add-form photo list with remove (x) buttons
let pendingFiles = [];
const pManager = document.getElementById('p-image-manager');

function renderPendingImages() {
  if (!pManager) return;
  pManager.innerHTML = '';
  pendingFiles.forEach((file, idx) => {
    const url = URL.createObjectURL(file);
    const thumb = document.createElement('div');
    thumb.className = 'img-thumb';
    thumb.innerHTML = `<img src="${url}" alt="Selected photo"><button type="button" class="remove-img" title="Remove">&times;</button>` +
      (idx === 0 ? '<span class="new-tag">Main</span>' : '');
    thumb.querySelector('.remove-img').addEventListener('click', () => {
      URL.revokeObjectURL(url);
      pendingFiles.splice(idx, 1);
      renderPendingImages();
    });
    pManager.appendChild(thumb);
  });
}

// 7b. AI buttons (Add form + Edit modal)
const aiBtn = document.getElementById('p-ai-btn');
const aiStatus = document.getElementById('p-ai-status');
const pFileInput = document.getElementById('p-image-file');

async function runAddFormAi(force) {
  const file = pendingFiles[0];
  if (!file) { aiStatus.textContent = 'Choose a photo first.'; return; }
  aiBtn.disabled = true;
  aiStatus.textContent = '✨ AI is reading your photo...';
  try {
    applyAiResult('p', await aiSuggest(file), force);
    aiStatus.textContent = '✅ Filled. Please check and edit before uploading.';
  } catch (err) {
    aiStatus.textContent = '⚠️ AI could not fill this (' + err.message + '). You can type it yourself.';
  } finally {
    aiBtn.disabled = false;
  }
}
aiBtn?.addEventListener('click', () => runAddFormAi(true));
pFileInput?.addEventListener('change', () => {
  const hadNone = pendingFiles.length === 0;
  pendingFiles.push(...Array.from(pFileInput.files));
  pFileInput.value = '';
  renderPendingImages();
  if (hadNone && pendingFiles.length) runAddFormAi(false);
});

const eAiBtn = document.getElementById('e-ai-btn');
const eAiStatus = document.getElementById('e-ai-status');
eAiBtn?.addEventListener('click', async () => {
  eAiBtn.disabled = true;
  eAiStatus.textContent = '✨ AI is reading the photo...';
  try {
    let source = newFiles[0];
    if (!source && keptImages[0]) source = await (await fetch(keptImages[0])).blob();
    if (!source) throw new Error('no image available');
    applyAiResult('e', await aiSuggest(source), true);
    eAiStatus.textContent = '✅ Filled. Please check before saving.';
  } catch (err) {
    eAiStatus.textContent = '⚠️ AI could not fill this (' + err.message + ').';
  } finally {
    eAiBtn.disabled = false;
  }
});

// While the admin page stays open, log out as soon as the 24 hours are up
const loggedInUI = () => authOverlay && authOverlay.style.display === 'none';
setInterval(() => { if (loggedInUI() && sessionExpired()) checkAuth(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && loggedInUI() && sessionExpired()) checkAuth();
});

loadCategories();
checkAuth();
