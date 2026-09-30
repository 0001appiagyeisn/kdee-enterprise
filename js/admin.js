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

const CATEGORIES = [
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
const normCat = (c) => (c === 'short_jeans' ? 'shorts' : (c || ''));
const catLabel = (c) => (CATEGORIES.find((x) => x.key === normCat(c)) || {}).label || 'No category';

['p-category', 'e-category'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<option value="">Select category</option>' +
    CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
});

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

// Uploads a single file to Supabase storage, returns public URL (or throws)
async function uploadImage(file) {
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
async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
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
      checkAuth();
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
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

// 3. Bulk selection UI
function updateBulkUI() {
  const count = selectedIds.size;
  selectedCountEl.textContent = `${count} selected`;
  bulkDeleteBtn.disabled = count === 0;
  selectAllBox.checked = allProducts.length > 0 && count === allProducts.length;
  selectAllBox.indeterminate = count > 0 && count < allProducts.length;
}

if (selectAllBox) {
  selectAllBox.addEventListener('change', () => {
    if (selectAllBox.checked) allProducts.forEach((p) => selectedIds.add(p.id));
    else selectedIds.clear();
    document.querySelectorAll('.stock-row').forEach((row) => {
      const check = row.querySelector('.row-check');
      check.checked = selectAllBox.checked;
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

// 4. Load Inventory Items
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

  // Drop selections for items that no longer exist
  const validIds = new Set(allProducts.map((p) => p.id));
  [...selectedIds].forEach((id) => { if (!validIds.has(id)) selectedIds.delete(id); });

  adminInventoryList.innerHTML = '';

  allProducts.forEach((prod) => {
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

      const { error: updateError } = await supabase
        .from('products')
        .update({ stock: newStock })
        .eq('id', prod.id);

      if (updateError) alert('Update failed: ' + updateError.message);
      else {
        alert('Stock updated successfully!');
        loadAdminInventory();
      }
    });

    row.querySelector('.btn-edit').addEventListener('click', () => openEditModal(prod));

    row.querySelector('.btn-delete').addEventListener('click', async () => {
      if (confirm(`Delete "${prod.name}"?`)) {
        const { error: deleteError } = await supabase
          .from('products')
          .delete()
          .eq('id', prod.id);

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
    const files = fileInput.files;

    if (files.length === 0) {
      alert('Please select at least one product image.');
      return;
    }

    const uploadBtn = document.getElementById('upload-btn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';

    const imageUrls = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
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
      loadAdminInventory();
    }
  });
}

checkAuth();
