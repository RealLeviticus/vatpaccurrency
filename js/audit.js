/**
 * Audit Results Page Logic
 * Display visiting and local controller audit results
 */

import api from './api.js';
import {
  formatDate,
  formatDuration,
  createStatusBadge,
  createRatingBadge,
  showError,
  showLoading,
  hideLoading,
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

// Active sort state
let activeSort = {
  visiting: { column: null, ascending: true },
  local: { column: null, ascending: true }
};

// Normalize audit records to the simplified schema the UI expects
function normalizeAuditRecord(audit, type = 'visiting') {
  if (!audit) {
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
      id = `audit_unknown_${Math.random().toString(36).slice(2)}`;
    }
  }

  const hoursLogged = Number(audit.hoursLogged ?? audit.hours ?? audit.totalHours ?? audit.time ?? 0) || 0;
  const lastSession = audit.lastSession || audit.lastControlled || audit.last_seen || audit.lastSeen || null;

  // Determine status from the audit record
  let status = 'pending';
  if (audit.status === 'not-division-member') {
    status = 'not-division-member';
  } else if (audit.status === 'pending') {
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
    rating: audit.rating || 'N/A',
    division: audit.division || null,
    hoursLogged,
    lastSession,
    flagged: status === 'flagged' || status === 'not-division-member'
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

    if (kvData) {
      visitingData = (kvData.visiting || []).map(a => normalizeAuditRecord(a, 'visiting'));
      localData = (kvData.local || []).map(a => normalizeAuditRecord(a, 'local'));
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
    // Show retry button in table bodies
    ['visiting', 'local'].forEach(type => {
      const tbody = document.getElementById(`${type}TableBody`);
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center;">
              <div class="empty-state">
                <div class="empty-state-icon">⚠️</div>
                <p>${escapeHTML(`Failed to load data: ${error.message}`)}</p>
                <button class="btn-secondary btn-sm" style="margin-top: 1rem;" onclick="location.reload()">Retry</button>
              </div>
            </td>
          </tr>
        `;
      }
    });
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
      if (filters.status === 'not-division-member' && audit.status !== 'not-division-member') return false;
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

  // Get filtered data based on active search/filter
  const data = getFilteredData(type);

  if (data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center;">
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
  // Clamp page to valid range
  if (currentPage[type] > totalPages) currentPage[type] = totalPages;
  if (currentPage[type] < 1) currentPage[type] = 1;
  const page = currentPage[type];
  const startIdx = (page - 1) * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageData = data.slice(startIdx, endIdx);

  // Render table rows
  tbody.innerHTML = pageData.map(audit => {

    // Determine status display based on actual status values
    let status = 'requirement-met';
    if (audit.status === 'not-division-member') {
      status = 'not-division-member';
    } else if (audit.status === 'pending') {
      status = 'pending';
    } else if (audit.status === 'flagged' || audit.flagged === true) {
      status = 'requirement-not-met';
    } else if (audit.status === 'completed') {
      status = 'requirement-met';
    } else {
      // Default to pending for unknown statuses
      status = 'pending';
    }

    // Extract CID from id field (format: "audit_XXXXXX") and sanitize
    const rawCid = audit.id ? String(audit.id).replace('audit_', '') : 'N/A';
    const cid = escapeHTML(rawCid);
    const rating = escapeHTML(audit.rating || 'N/A');
    const hoursLogged = Number(audit.hoursLogged) || 0;
    const lastControlled = audit.lastSession ? escapeHTML(formatDate(audit.lastSession)) : 'Never';

    return `
      <tr class="audit-row-${status}">
        <td>${cid}</td>
        <td>${createRatingBadge(rating)}</td>
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
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });

  // Update tab content
  document.querySelectorAll('.audit-tab').forEach(tab => {
    tab.classList.toggle('active', tab.id === `${tabName}Tab`);
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
function updatePagination(type, pageNum, totalPages, totalItems) {
  const pagination = document.getElementById(`${type}Pagination`);
  const pageInfo = document.getElementById(`${type}PageInfo`);
  const prevBtn = document.getElementById(`${type}PrevBtn`);
  const nextBtn = document.getElementById(`${type}NextBtn`);

  if (!pagination || totalPages <= 1) {
    if (pagination) pagination.style.display = 'none';
    return;
  }

  pagination.style.display = 'flex';
  
  const startItem = (pageNum - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(pageNum * ITEMS_PER_PAGE, totalItems);
  
  pageInfo.textContent = `Showing ${startItem}-${endItem} of ${totalItems} (Page ${pageNum} of ${totalPages})`;
  
  prevBtn.disabled = pageNum === 1;
  nextBtn.disabled = pageNum === totalPages;
  prevBtn.setAttribute('aria-disabled', pageNum === 1);
  nextBtn.setAttribute('aria-disabled', pageNum === totalPages);
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
        // Scroll to table, not top of page
        const tableWrapper = document.querySelector(`#${type}Tab .table-wrapper`);
        if (tableWrapper) {
          tableWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const filteredData = getFilteredData(type);
      const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE);
      if (currentPage[type] < totalPages) {
        currentPage[type]++;
        renderAuditTable(type);
        // Scroll to table, not top of page
        const tableWrapper = document.querySelector(`#${type}Tab .table-wrapper`);
        if (tableWrapper) {
          tableWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
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

// ==================== Data-level Sorting ====================

/**
 * Sort column key to audit record accessor
 */
const SORT_ACCESSORS = {
  cid: audit => {
    const raw = audit.id ? String(audit.id).replace('audit_', '') : '';
    return parseInt(raw, 10) || 0;
  },
  rating: audit => audit.rating || '',
  status: audit => audit.status || '',
  hours: audit => Number(audit.hoursLogged) || 0,
  lastControlled: audit => audit.lastSession ? new Date(audit.lastSession).getTime() : 0
};

/**
 * Setup sortable column headers for a table (sorts backing data, not DOM)
 * @param {'visiting'|'local'} type - Audit type
 */
function setupDataSort(type) {
  const tab = document.getElementById(`${type}Tab`);
  if (!tab) return;

  const headers = tab.querySelectorAll('th[data-sort]');
  headers.forEach(header => {
    header.classList.add('sortable');
    header.style.cursor = 'pointer';

    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      const accessor = SORT_ACCESSORS[key];
      if (!accessor) return;

      // Toggle direction
      if (activeSort[type].column === key) {
        activeSort[type].ascending = !activeSort[type].ascending;
      } else {
        activeSort[type].column = key;
        activeSort[type].ascending = true;
      }

      const asc = activeSort[type].ascending;
      const data = type === 'visiting' ? visitingData : localData;

      data.sort((a, b) => {
        const aVal = accessor(a);
        const bVal = accessor(b);
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return asc ? aVal - bVal : bVal - aVal;
        }
        return asc
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal));
      });

      // Update aria-sort on all headers
      headers.forEach(h => h.removeAttribute('aria-sort'));
      header.setAttribute('aria-sort', asc ? 'ascending' : 'descending');

      currentPage[type] = 1;
      renderAuditTable(type);
    });
  });
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

  // Setup data-level sorting for both tabs
  setupDataSort('visiting');
  setupDataSort('local');

  // Add manual refresh button functionality if it exists
  const refreshBtn = document.getElementById('refreshAudits');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAudits();
    });
  }
});
