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
  debounce,
  escapeHTML
} from './utils.js';

let visitingData = [];
let localData = [];
let currentTab = 'visiting';
const ITEMS_PER_PAGE = 25;
let currentPage = {
  visiting: 1,
  local: 1
};

// Active search and filter state
let activeFilters = {
  visiting: { search: '', status: 'all' },
  local: { search: '', status: 'all' }
};

// Normalize audit records to the simplified schema the UI expects
function normalizeAuditRecord(audit, type = 'visiting') {
  if (!audit) {
    console.warn('normalizeAuditRecord received null/undefined audit');
    return {
      id: 'audit_unknown',
      type,
      status: 'pending',
      hoursLogged: 0,
      lastSession: null,
      flagged: false
    };
  }

  // The audit.id should already be in format "audit_XXXXXX" from worker
  // If it's missing the audit_ prefix, add it
  let id = audit.id;
  if (id && !id.startsWith('audit_')) {
    id = `audit_${id}`;
  } else if (!id) {
    // Fallback: try to extract CID from other fields
    const rawCid = audit.cid
      || audit.controller?.cid
      || audit.user?.cid
      || audit.controllerId
      || audit.memberId;

    if (rawCid) {
      id = `audit_${rawCid}`;
    } else {
      console.warn('Could not extract CID from audit record:', audit);
      id = `audit_unknown_${Math.random().toString(36).slice(2)}`;
    }
  }

  const hoursLogged = Number(audit.hoursLogged ?? audit.hours ?? audit.totalHours ?? audit.time ?? 0) || 0;
  const lastSession = audit.lastSession || audit.lastControlled || audit.last_seen || audit.lastSeen || null;

  // Determine status from the audit record
  let status = 'pending';
  if (audit.status === 'pending') {
    status = 'pending';
  } else if (audit.status === 'flagged' || audit.flagged === true) {
    status = 'flagged';
  } else if (audit.status === 'completed') {
    status = 'completed';
  } else {
    // Derive status if not explicitly provided
    if (audit.flagged === true) {
      status = 'flagged';
    } else if (hoursLogged > 0 || lastSession) {
      status = 'completed';
    } else {
      status = 'pending';
    }
  }

  return {
    id,
    type: audit.type || type,
    status,
    hoursLogged,
    lastSession,
    flagged: status === 'flagged'
  };
}

/**
 * Load audit data from API (directly from KV)
 */
async function loadAudits() {
  try {
    showLoading('Loading audit results...');

    // Fetch directly from KV endpoint for faster, always up-to-date data
    const kvData = await api.getKVData().catch(() => null);

    console.log('KV Data received:', kvData);

    if (kvData) {
      visitingData = (kvData.visiting || []).map(a => normalizeAuditRecord(a, 'visiting'));
      localData = (kvData.local || []).map(a => normalizeAuditRecord(a, 'local'));
      console.log(`Loaded ${visitingData.length} visiting and ${localData.length} local records`);
    } else {
      // Fallback to old endpoint structure
      const [visiting, local] = await Promise.all([
        api.getVisitingAudit().catch(() => ({active: [], completed: [], stats: {}})),
        api.getLocalAudit().catch(() => ({active: [], completed: [], stats: {}}))
      ]);
      visitingData = [...(visiting.active || []), ...(visiting.completed || [])]
        .map(a => normalizeAuditRecord(a, 'visiting'));
      localData = [...(local.active || []), ...(local.completed || [])]
        .map(a => normalizeAuditRecord(a, 'local'));
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
 * Get filtered data based on active search and filter
 * @param {'visiting'|'local'} type - Audit type
 * @returns {Array} Filtered data array
 */
function getFilteredData(type) {
  const data = type === 'visiting' ? visitingData : localData;
  const filters = activeFilters[type];

  if (!data || data.length === 0) return [];

  return data.filter(audit => {
    // Apply status filter
    if (filters.status !== 'all') {
      if (filters.status === 'pending' && audit.status !== 'pending') return false;
      if (filters.status === 'requirement-not-met' && audit.status !== 'flagged') return false;
      if (filters.status === 'requirement-met' && audit.status !== 'completed') return false;
    }

    // Apply search filter (search CID)
    if (filters.search && filters.search.trim() !== '') {
      const cid = audit.id ? String(audit.id).replace('audit_', '') : '';
      const searchTerm = filters.search.toLowerCase();
      if (!cid.toLowerCase().includes(searchTerm)) return false;
    }

    return true;
  });
}

/**
 * Render audit table for specified type
 * @param {'visiting'|'local'} type - Audit type
 */
function renderAuditTable(type) {
  const allData = type === 'visiting' ? visitingData : localData;
  const tbody = document.getElementById(`${type}TableBody`);
  const pagination = document.getElementById(`${type}Pagination`);

  if (!allData || allData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center;">
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

  // Get filtered data based on active search/filter
  const data = getFilteredData(type);

  if (data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center;">
          <div class="empty-state">
            <div class="empty-state-icon">🔍</div>
            <p>No results found for current search/filter</p>
            <small>Try adjusting your search or filter criteria</small>
          </div>
        </td>
      </tr>
    `;
    if (pagination) pagination.style.display = 'none';
    return;
  }

  // Calculate pagination
  const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);
  const page = currentPage[type];
  const startIdx = (page - 1) * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageData = data.slice(startIdx, endIdx);

  console.log(`Rendering ${type}: page ${page}/${totalPages}, showing ${pageData.length} of ${data.length} total items`);

  // Render table rows
  console.log('Rendering table with data:', pageData);
  tbody.innerHTML = pageData.map(audit => {
    console.log('Processing audit record:', audit);

    // Determine status display based on actual status values
    let status = 'requirement-met';
    if (audit.status === 'pending') {
      status = 'pending';
    } else if (audit.status === 'flagged' || audit.flagged === true) {
      status = 'requirement-not-met';
    } else if (audit.status === 'completed') {
      status = 'requirement-met';
    } else {
      // Log unexpected status values
      console.warn(`Unexpected audit.status value: "${audit.status}", flagged: ${audit.flagged}`);
      // Default to pending for unknown statuses
      status = 'pending';
    }

    // Extract CID from id field (format: "audit_XXXXXX") and sanitize
    const rawCid = audit.id ? String(audit.id).replace('audit_', '') : 'N/A';
    const cid = escapeHTML(rawCid);
    const hoursLogged = Number(audit.hoursLogged) || 0;
    const lastControlled = audit.lastSession ? escapeHTML(formatDate(audit.lastSession)) : 'Never';

    console.log(`Row: CID=${cid}, status=${status}, hours=${hoursLogged}, lastSession=${lastControlled}`);

    return `
      <tr class="audit-row-${status}">
        <td>${cid}</td>
        <td>${createStatusBadge(status)}</td>
        <td>${escapeHTML(formatDuration(hoursLogged))}</td>
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
      const searchTerm = event.target.value;

      // Update active filter state
      activeFilters[type].search = searchTerm;

      // Reset to page 1 when searching
      currentPage[type] = 1;

      // Re-render table with filtered data
      renderAuditTable(type);
    }, 300));
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', (event) => {
      const filter = event.target.value;

      // Update active filter state
      activeFilters[type].status = filter;

      // Reset to page 1 when filtering
      currentPage[type] = 1;

      // Re-render table with filtered data
      renderAuditTable(type);
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
