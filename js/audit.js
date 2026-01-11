/**
 * Audit Results Page Logic
 * Display visiting and local controller audit results
 */

import api from './api.js';
import {
  sortTable,
  filterTable,
  formatDate,
  formatDuration,
  createProgressBar,
  createStatusBadge,
  showError,
  showLoading,
  hideLoading,
  makeTableSortable,
  debounce
} from './utils.js';

let visitingData = [];
let localData = [];
let currentTab = 'visiting';
const ITEMS_PER_PAGE = 25;
let currentPage = {
  visiting: 1,
  local: 1
};

/**
 * Load audit data from API (directly from KV)
 */
async function loadAudits() {
  try {
    showLoading('Loading audit results...');

    // Fetch directly from KV endpoint for faster, always up-to-date data
    const kvData = await api.getKVData().catch(() => null);

    if (kvData) {
      visitingData = kvData.visiting || [];
      localData = kvData.local || [];
    } else {
      // Fallback to old endpoint structure
      const [visiting, local] = await Promise.all([
        api.getVisitingAudit().catch(() => ({active: [], completed: [], stats: {}})),
        api.getLocalAudit().catch(() => ({active: [], completed: [], stats: {}}))
      ]);
      visitingData = [...(visiting.active || []), ...(visiting.completed || [])];
      localData = [...(local.active || []), ...(local.completed || [])];
    }

    renderAuditTable(currentTab);
    hideLoading();
  } catch (error) {
    console.error('Failed to load audits:', error);
    showError(`Failed to load audit data: ${error.message}`);
    hideLoading();
  }
}

/**
 * Render audit table for specified type
 * @param {'visiting'|'local'} type - Audit type
 */
function renderAuditTable(type) {
  const data = type === 'visiting' ? visitingData : localData;
  const tbody = document.getElementById(`${type}TableBody`);
  const pagination = document.getElementById(`${type}Pagination`);

  if (!data || data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center;">
          <div class="empty-state">
            <div class="empty-state-icon">📊</div>
            <p>No ${type} audit data available</p>
          </div>
        </td>
      </tr>
    `;
    if (pagination) pagination.style.display = 'none';
    return;
  }

  // Reset search/filter when rendering
  const searchInput = document.getElementById(`${type}Search`);
  const filterSelect = document.getElementById(`${type}Filter`);
  if (searchInput) searchInput.value = '';
  if (filterSelect) filterSelect.value = 'all';

  // Calculate pagination
  const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);
  const page = currentPage[type];
  const startIdx = (page - 1) * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageData = data.slice(startIdx, endIdx);

  console.log(`Rendering ${type}: page ${page}/${totalPages}, showing ${pageData.length} of ${data.length} total items`);

  // Render table rows
  tbody.innerHTML = pageData.map(audit => {
    // Determine status display
    let status = 'requirement-met';
    if (audit.status === 'pending') {
      status = 'pending';
    } else if (audit.flagged) {
      status = 'requirement-not-met';
    }
    
    const hoursLogged = audit.hoursLogged || 0;
    const cid = audit.cid || 'N/A';
    const name = audit.name || 'Unknown';
    const lastControlled = audit.lastSession ? formatDate(audit.lastSession) : 'Never';

    return `
      <tr class="audit-row-${status}">
        <td>${cid}</td>
        <td>${name}</td>
        <td>${createStatusBadge(status)}</td>
        <td>${formatDuration(hoursLogged)}</td>
        <td>${lastControlled}</td>
      </tr>
    `;
  }).join('');

  // Update pagination controls
  updatePagination(type, page, totalPages, data.length);
}

/**
 * Switch between tabs
 * @param {'visiting'|'local'} tabName - Tab to switch to
 */
function switchTab(tabName) {
  currentTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update tab content
  document.querySelectorAll('.audit-tab').forEach(tab => {
    if (tab.id === `${tabName}Tab`) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Render appropriate table
  renderAuditTable(tabName);
}

/**
 * Update pagination controls
 * @param {'visiting'|'local'} type - Audit type
 * @param {number} currentPage - Current page number
 * @param {number} totalPages - Total number of pages
 * @param {number} totalItems - Total number of items
 */
function updatePagination(type, currentPage, totalPages, totalItems) {
  const pagination = document.getElementById(`${type}Pagination`);
  const pageInfo = document.getElementById(`${type}PageInfo`);
  const prevBtn = document.getElementById(`${type}PrevBtn`);
  const nextBtn = document.getElementById(`${type}NextBtn`);

  if (!pagination || totalPages <= 1) {
    if (pagination) pagination.style.display = 'none';
    return;
  }

  pagination.style.display = 'flex';
  
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalItems);
  
  pageInfo.textContent = `Showing ${startItem}-${endItem} of ${totalItems} (Page ${currentPage} of ${totalPages})`;
  
  prevBtn.disabled = currentPage === 1;
  nextBtn.disabled = currentPage === totalPages;
}

/**
 * Setup pagination buttons
 * @param {'visiting'|'local'} type - Audit type
 */
function setupPagination(type) {
  const prevBtn = document.getElementById(`${type}PrevBtn`);
  const nextBtn = document.getElementById(`${type}NextBtn`);

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage[type] > 1) {
        currentPage[type]--;
        renderAuditTable(type);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const data = type === 'visiting' ? visitingData : localData;
      const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);
      if (currentPage[type] < totalPages) {
        currentPage[type]++;
        renderAuditTable(type);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
}

// ==================== Search and Filter ====================

/**
 * Setup search for a specific tab
 * @param {'visiting'|'local'} type - Audit type
 */
function setupSearch(type) {
  const searchInput = document.getElementById(`${type}Search`);
  const filterSelect = document.getElementById(`${type}Filter`);

  if (searchInput) {
    searchInput.addEventListener('input', debounce((event) => {
      const tbody = document.getElementById(`${type}TableBody`);
      const searchTerm = event.target.value;

      // Search in CID (column 0) and Name (column 1)
      filterTable(tbody, searchTerm, [0, 1]);
    }, 300));
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', (event) => {
      const filter = event.target.value;
      const rows = document.querySelectorAll(`#${type}TableBody tr`);

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
          const badgeText = statusCell?.textContent.toLowerCase().trim();

          // Map filter values to badge text
          let shouldShow = false;
          if (filter === 'pending' && badgeText === 'pending audit') {
            shouldShow = true;
          } else if (filter === 'requirement-not-met' && badgeText === 'requirement not met') {
            shouldShow = true;
          } else if (filter === 'requirement-met' && badgeText === 'requirement met') {
            shouldShow = true;
          }

          row.style.display = shouldShow ? '' : 'none';
        }
      });
    });
  }
}

// ==================== Initialize ====================

document.addEventListener('DOMContentLoaded', () => {
  // Load audit data
  loadAudits();

  // Setup tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      switchTab(tabName);
    });
  });

  // Setup search and filter for both tabs
  setupSearch('visiting');
  setupSearch('local');

  // Setup pagination for both tabs
  setupPagination('visiting');
  setupPagination('local');

  // Make tables sortable
  document.querySelectorAll('.data-table').forEach(table => {
    makeTableSortable(table);
  });

  // Add manual refresh button functionality if it exists
  const refreshBtn = document.getElementById('refreshAudits');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAudits();
    });
  }
});
