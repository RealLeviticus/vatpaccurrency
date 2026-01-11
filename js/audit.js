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

/**
 * Load audit data from API
 */
async function loadAudits() {
  try {
    showLoading('Loading audit results...');

    const [visiting, local] = await Promise.all([
      api.getVisitingAudit().catch(() => ({active: [], completed: [], stats: {}})),
      api.getLocalAudit().catch(() => ({active: [], completed: [], stats: {}}))
    ]);

    // Combine active and completed audits
    visitingData = [...(visiting.active || []), ...(visiting.completed || [])];
    localData = [...(local.active || []), ...(local.completed || [])];

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
  const targetHours = type === 'visiting' ? 10 : 15;

  if (!data || data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center;">
          <div class="empty-state">
            <div class="empty-state-icon">📊</div>
            <p>No ${type} audit data available</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = data.map(audit => {
    const status = audit.status || 'pending';
    const hoursLogged = audit.hoursLogged || 0;
    const cid = audit.cid || 'N/A';
    const name = audit.name || 'Unknown';
    const ticksRemaining = (status === 'active' && audit.ticksRemaining != null)
      ? audit.ticksRemaining
      : '-';
    const startedAt = audit.startedAt || null;
    const completedAt = audit.completedAt || null;

    return `
      <tr class="audit-row-${status}">
        <td>${cid}</td>
        <td>${name}</td>
        <td>${createStatusBadge(status)}</td>
        <td>${formatDuration(hoursLogged)}</td>
        <td>${ticksRemaining}</td>
        <td>${formatDate(startedAt)}</td>
        <td>${formatDate(completedAt)}</td>
        <td>${createProgressBar(hoursLogged, targetHours)}</td>
      </tr>
    `;
  }).join('');
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
          const rowStatus = statusCell?.textContent.toLowerCase().trim();

          row.style.display = rowStatus === filter ? '' : 'none';
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
