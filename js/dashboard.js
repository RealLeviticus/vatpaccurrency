/**
 * Dashboard Page Logic
 * Displays stats and currently online controllers
 */

import api from './api.js';
import {formatDate, createStatusBadge, showError, hideLoading, showLoading} from './utils.js';

let refreshInterval = null;

/**
 * Load dashboard data
 */
async function loadDashboard() {
  try {
    // Load stats and presence in parallel
    const [stats, presence] = await Promise.all([
      api.getStats().catch(() => ({
        totalWatched: 0,
        activeAudits: 0,
        completedAudits: 0
      })),
      api.getPresence().catch(() => ({online: []}))
    ]);

    // Update stats cards
    document.getElementById('totalWatched').textContent = stats.totalWatched || 0;
    document.getElementById('activeAudits').textContent = stats.activeAudits || 0;
    document.getElementById('completedAudits').textContent = stats.completedAudits || 0;
    document.getElementById('onlineNow').textContent = presence.online?.length || 0;

    // Render online controllers
    renderPresence(presence.online || []);

    hideLoading();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    showError(`Failed to load dashboard: ${error.message}`);
    hideLoading();
  }
}

/**
 * Render currently online controllers
 * @param {Array} controllers - Online controllers
 */
function renderPresence(controllers) {
  const container = document.getElementById('presenceList');

  if (!controllers || controllers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✈️</div>
        <p>No watched controllers currently online</p>
      </div>
    `;
    return;
  }

  container.innerHTML = controllers.map(ctrl => `
    <div class="presence-card">
      <div class="presence-header">
        <span class="callsign">${ctrl.callsign || 'UNKNOWN'}</span>
        ${createStatusBadge('online', 'Online')}
      </div>
      <div class="presence-details">
        <p><strong>${ctrl.name || 'Unknown'}</strong> (${ctrl.cid || 'N/A'})</p>
        ${ctrl.frequency ? `<p>Frequency: ${ctrl.frequency} MHz</p>` : ''}
        ${ctrl.logonTime ? `<p>Since: ${formatDate(ctrl.logonTime)}</p>` : ''}
      </div>
    </div>
  `).join('');
}

/**
 * Start auto-refresh
 */
function startAutoRefresh() {
  // Refresh every 30 seconds
  refreshInterval = setInterval(() => {
    loadDashboard();
  }, 30000);
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  showLoading('Loading dashboard...');
  loadDashboard();
  startAutoRefresh();
});

// Stop refresh when page is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    loadDashboard();
    startAutoRefresh();
  }
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  stopAutoRefresh();
});
