/**
 * Shared Utility Functions
 * Used across multiple pages for common operations
 */

// ==================== Table Sorting ====================

/**
 * Sort a table by clicking column headers
 * @param {HTMLTableSectionElement} tbody - Table body element
 * @param {number} columnIndex - Column to sort by
 * @param {boolean} ascending - Sort direction
 */
export function sortTable(tbody, columnIndex, ascending = true) {
  const rows = Array.from(tbody.querySelectorAll('tr'));

  rows.sort((a, b) => {
    const aCell = a.cells[columnIndex];
    const bCell = b.cells[columnIndex];

    if (!aCell || !bCell) return 0;

    // Get text content, stripping HTML
    let aValue = aCell.textContent.trim();
    let bValue = bCell.textContent.trim();

    // Try numeric comparison first
    const aNum = parseFloat(aValue.replace(/[^0-9.-]/g, ''));
    const bNum = parseFloat(bValue.replace(/[^0-9.-]/g, ''));

    if (!isNaN(aNum) && !isNaN(bNum)) {
      return ascending ? aNum - bNum : bNum - aNum;
    }

    // Date comparison (check for ISO date format)
    if (aValue.match(/^\d{4}-\d{2}-\d{2}/) && bValue.match(/^\d{4}-\d{2}-\d{2}/)) {
      const aDate = new Date(aValue);
      const bDate = new Date(bValue);
      return ascending ? aDate - bDate : bDate - aDate;
    }

    // String comparison
    return ascending
      ? aValue.localeCompare(bValue)
      : bValue.localeCompare(aValue);
  });

  // Re-append rows in sorted order
  rows.forEach(row => tbody.appendChild(row));
}

// ==================== Table Filtering ====================

/**
 * Filter table rows based on search term
 * @param {HTMLTableSectionElement} tbody - Table body
 * @param {string} searchTerm - Search query
 * @param {number[]} columnIndices - Columns to search in
 */
export function filterTable(tbody, searchTerm, columnIndices) {
  const rows = tbody.querySelectorAll('tr');
  const term = searchTerm.toLowerCase();

  rows.forEach(row => {
    const text = columnIndices
      .map(i => row.cells[i]?.textContent || '')
      .join(' ')
      .toLowerCase();

    row.style.display = text.includes(term) ? '' : 'none';
  });
}

// ==================== Date Formatting ====================

/**
 * Format ISO date string to Australian format
 * @param {string} isoString - ISO 8601 date string
 * @param {boolean} includeTime - Include time in output
 * @returns {string} Formatted date
 */
export function formatDate(isoString, includeTime = true) {
  if (!isoString) return '-';

  const date = new Date(isoString);
  if (!isFinite(date.getTime())) return '-';

  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  };

  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.timeZoneName = 'short';
  }

  return date.toLocaleDateString('en-AU', options);
}

/**
 * Format relative time (e.g., "2 hours ago")
 * @param {string} isoString - ISO 8601 date string
 * @returns {string} Relative time string
 */
export function formatRelativeTime(isoString) {
  if (!isoString) return '-';

  const date = new Date(isoString);
  if (!isFinite(date.getTime())) return '-';

  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;

  return formatDate(isoString, false);
}

// ==================== Duration Formatting ====================

/**
 * Format hours as human-readable duration
 * @param {number} hours - Duration in hours
 * @returns {string} Formatted duration
 */
export function formatDuration(hours) {
  if (hours == null || isNaN(hours)) return '-';

  if (hours < 1) {
    const minutes = Math.round(hours * 60);
    return `${minutes}m`;
  }

  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);

  if (m > 0) {
    return `${h}h ${m}m`;
  }
  return `${h}h`;
}

// ==================== Progress Bar ====================

/**
 * Create HTML for a progress bar
 * @param {number} current - Current value
 * @param {number} total - Total/target value
 * @returns {string} HTML string
 */
export function createProgressBar(current, total) {
  const percentage = Math.min(100, Math.max(0, (current / total) * 100));
  const isComplete = current >= total;
  const isWarning = current < total * 0.5 && current > 0;

  let fillClass = 'progress-fill';
  if (isComplete) fillClass += ' complete';
  else if (isWarning) fillClass += ' warning';

  return `
    <div class="progress-bar">
      <div class="${fillClass}" style="width: ${percentage}%"></div>
      <span class="progress-text">${current.toFixed(1)}/${total}h</span>
    </div>
  `;
}

// ==================== Status Badges ====================

/**
 * Create HTML for a status badge
 * @param {string} status - Status type
 * @param {string} text - Optional custom text
 * @returns {string} HTML string
 */
export function createStatusBadge(status, text = null) {
  const badges = {
    online: 'badge-success',
    offline: 'badge-secondary',
    active: 'badge-info',
    completed: 'badge-success',
    flagged: 'badge-danger',
    failed: 'badge-danger',
    pending: 'badge-warning'
  };

  const badgeClass = badges[status] || 'badge-secondary';
  const badgeText = text || status.charAt(0).toUpperCase() + status.slice(1);

  return `<span class="badge ${badgeClass}">${badgeText}</span>`;
}

// ==================== Error Handling ====================

/**
 * Show error message to user
 * @param {string} message - Error message
 * @param {HTMLElement} container - Container element (optional)
 */
export function showError(message, container = null) {
  const errorHTML = `
    <div class="status-message status-error">
      ${message}
    </div>
  `;

  if (container) {
    container.innerHTML = errorHTML;
  } else {
    // Create toast notification
    const toast = document.createElement('div');
    toast.className = 'status-message status-error';
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.zIndex = '9999';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 5000);
  }
}

/**
 * Show success message to user
 * @param {string} message - Success message
 * @param {HTMLElement} container - Container element (optional)
 */
export function showSuccess(message, container = null) {
  const successHTML = `
    <div class="status-message status-success">
      ${message}
    </div>
  `;

  if (container) {
    container.innerHTML = successHTML;
  } else {
    // Create toast notification
    const toast = document.createElement('div');
    toast.className = 'status-message status-success';
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.zIndex = '9999';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  }
}

// ==================== Loading States ====================

/**
 * Show loading overlay
 * @param {string} message - Loading message
 */
export function showLoading(message = 'Loading...') {
  // Remove existing overlay if present
  hideLoading();

  const overlay = document.createElement('div');
  overlay.id = 'loadingOverlay';
  overlay.className = 'loading-overlay';
  overlay.innerHTML = `
    <div class="loading"></div>
    <p style="color: var(--text-secondary); margin-top: 1rem;">${message}</p>
  `;

  document.body.appendChild(overlay);
}

/**
 * Hide loading overlay
 */
export function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.remove();
  }
}

// ==================== Validation ====================

/**
 * Validate VATSIM CID format
 * @param {string} cid - Controller CID
 * @returns {boolean} Is valid
 */
export function isValidCID(cid) {
  const cidStr = String(cid).trim();
  return /^\d{3,10}$/.test(cidStr);
}

/**
 * Sanitize HTML to prevent XSS
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
export function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== Table Setup ====================

/**
 * Make table headers sortable
 * @param {HTMLTableElement} table - Table element
 */
export function makeTableSortable(table) {
  const headers = table.querySelectorAll('th[data-sort]');

  headers.forEach((header, index) => {
    header.classList.add('sortable');
    let ascending = true;

    header.addEventListener('click', () => {
      const tbody = table.querySelector('tbody');
      if (!tbody) return;

      // Get column index
      const columnIndex = Array.from(header.parentElement.children).indexOf(header);

      // Sort table
      sortTable(tbody, columnIndex, ascending);

      // Toggle direction for next click
      ascending = !ascending;

      // Visual feedback
      headers.forEach(h => h.style.opacity = '0.7');
      header.style.opacity = '1';
    });
  });
}

// ==================== Debouncing ====================

/**
 * Debounce function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function} Debounced function
 */
export function debounce(func, wait = 300) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
