/**
 * Watchlist Management Page Logic
 * Add, remove, and view controllers on the watchlist
 */

import api from './api.js';
import {
  sortTable,
  filterTable,
  formatDate,
  createStatusBadge,
  showError,
  showSuccess,
  showLoading,
  hideLoading,
  isValidCID,
  makeTableSortable
} from './utils.js';

let watchlistData = [];

/**
 * Load watchlist from API
 */
async function loadWatchlist() {
  try {
    showLoading('Loading watchlist...');

    const data = await api.getWatchlist();
    watchlistData = data.users || [];

    renderWatchlist();
    hideLoading();
  } catch (error) {
    console.error('Failed to load watchlist:', error);
    showError(`Failed to load watchlist: ${error.message}`);
    hideLoading();
  }
}

/**
 * Render watchlist table
 */
function renderWatchlist() {
  const tbody = document.getElementById('watchlistTableBody');

  if (!watchlistData || watchlistData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center;">
          <div class="empty-state">
            <div class="empty-state-icon">👀</div>
            <p>No controllers on the watchlist</p>
            <p style="font-size: 0.9rem; margin-top: 0.5rem;">Click "Add Controller" to get started</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = watchlistData.map(user => `
    <tr>
      <td>${user.cid || 'N/A'}</td>
      <td>${user.name || 'Unknown'}</td>
      <td>${createStatusBadge(user.isOnline ? 'online' : 'offline')}</td>
      <td>${formatDate(user.addedAt, false)}</td>
      <td>
        <button class="btn-danger btn-sm" onclick="window.removeController('${user.cid}')">
          Remove
        </button>
      </td>
    </tr>
  `).join('');
}

/**
 * Remove controller from watchlist
 * @param {string} cid - Controller CID
 */
async function removeController(cid) {
  if (!confirm(`Are you sure you want to remove controller ${cid} from the watchlist?`)) {
    return;
  }

  try {
    showLoading('Removing controller...');

    await api.removeFromWatchlist(cid);

    showSuccess(`Controller ${cid} removed successfully`);

    // Reload watchlist
    await loadWatchlist();
  } catch (error) {
    console.error('Failed to remove controller:', error);
    showError(`Failed to remove controller: ${error.message}`);
    hideLoading();
  }
}

// Export to window so inline onclick works
window.removeController = removeController;

// ==================== Modal Logic ====================

const modal = document.getElementById('addModal');
const addBtn = document.getElementById('addControllerBtn');
const closeBtn = document.querySelector('.close');
const cancelBtn = document.getElementById('cancelBtn');
const addForm = document.getElementById('addControllerForm');
const cidInput = document.getElementById('cidInput');
const statusDiv = document.getElementById('addStatus');

/**
 * Open add controller modal
 */
function openModal() {
  modal.style.display = 'block';
  cidInput.value = '';
  statusDiv.innerHTML = '';
  cidInput.focus();
}

/**
 * Close add controller modal
 */
function closeModal() {
  modal.style.display = 'none';
}

// Modal event listeners
addBtn.addEventListener('click', openModal);
closeBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);

// Close modal when clicking outside
window.addEventListener('click', (event) => {
  if (event.target === modal) {
    closeModal();
  }
});

// Close modal on Escape key
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal.style.display === 'block') {
    closeModal();
  }
});

/**
 * Handle add controller form submission
 */
addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const cid = cidInput.value.trim();

  // Validate CID
  if (!isValidCID(cid)) {
    statusDiv.innerHTML = `
      <div class="status-message status-error">
        Invalid CID format. Please enter a valid VATSIM CID (3-10 digits).
      </div>
    `;
    return;
  }

  try {
    // Show loading status
    statusDiv.innerHTML = `
      <div class="status-message status-info">
        Adding controller ${cid}...
      </div>
    `;

    // Disable form
    addForm.querySelectorAll('input, button').forEach(el => el.disabled = true);

    // Add to watchlist
    await api.addToWatchlist(cid);

    // Show success
    statusDiv.innerHTML = `
      <div class="status-message status-success">
        Controller ${cid} added successfully!
      </div>
    `;

    // Close modal and reload after short delay
    setTimeout(async () => {
      closeModal();
      await loadWatchlist();
    }, 1500);

  } catch (error) {
    console.error('Failed to add controller:', error);

    statusDiv.innerHTML = `
      <div class="status-message status-error">
        ${error.message}
      </div>
    `;

    // Re-enable form
    addForm.querySelectorAll('input, button').forEach(el => el.disabled = false);
  }
});

// ==================== Search and Filter ====================

const searchInput = document.getElementById('watchlistSearch');
const statusFilter = document.getElementById('statusFilter');

/**
 * Handle search input
 */
searchInput.addEventListener('input', (event) => {
  const tbody = document.getElementById('watchlistTableBody');
  const searchTerm = event.target.value;

  // Filter by CID (column 0) and Name (column 1)
  filterTable(tbody, searchTerm, [0, 1]);
});

/**
 * Handle status filter
 */
statusFilter.addEventListener('change', (event) => {
  const filter = event.target.value;
  const rows = document.querySelectorAll('#watchlistTableBody tr');

  rows.forEach(row => {
    // Skip empty state row
    if (row.cells.length === 1) {
      row.style.display = '';
      return;
    }

    if (filter === 'all') {
      row.style.display = '';
    } else {
      const statusCell = row.cells[2];
      const hasOnlineBadge = statusCell?.innerHTML.includes('badge-success');
      const shouldShow =
        (filter === 'online' && hasOnlineBadge) ||
        (filter === 'offline' && !hasOnlineBadge);

      row.style.display = shouldShow ? '' : 'none';
    }
  });
});

// ==================== Initialize ====================

document.addEventListener('DOMContentLoaded', () => {
  // Load watchlist
  loadWatchlist();

  // Make table sortable
  const table = document.querySelector('.data-table');
  if (table) {
    makeTableSortable(table);
  }
});
