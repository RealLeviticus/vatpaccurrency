/**
 * VATPAC Watchlist API Client
 * Handles all communication with the Cloudflare Worker backend
 */

const API_BASE = 'https://vatsimactivitybot.therealleviticus.workers.dev/api';
// Optional: Public R2 JSON URL (set in index.html as window.R2_JSON_URL)
const R2_JSON_URL = typeof window !== 'undefined' ? (window.R2_JSON_URL || null) : null;

async function fetchR2Store() {
  if (!R2_JSON_URL) throw new Error('R2_JSON_URL not configured');
  const r = await fetch(R2_JSON_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`R2 fetch failed: ${r.status}`);
  return r.json();
}

class WatchlistAPI {
  constructor(baseURL = API_BASE) {
    this.baseURL = baseURL;
  }

  /**
   * Make a request to the API
   * @param {string} endpoint - API endpoint (e.g., '/watchlist')
   * @param {object} options - Fetch options
   * @returns {Promise<any>} JSON response
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({
          error: `HTTP ${response.status}: ${response.statusText}`
        }));
        throw new Error(error.error || error.message || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      // Re-throw with more context
      if (error.message.includes('Failed to fetch')) {
        throw new Error('Unable to connect to API. Please check your internet connection.');
      }
      throw error;
    }
  }

  // ==================== Watchlist Endpoints ====================

  /**
   * Get all controllers on the watchlist
   * @returns {Promise<{users: Array}>}
   */
  async getWatchlist() {
    return this.request('/watchlist');
  }

  /**
   * Add a controller to the watchlist
   * @param {string|number} cid - Controller CID
   * @returns {Promise<{success: boolean, user: object}>}
   */
  async addToWatchlist(cid) {
    return this.request('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ cid: String(cid) })
    });
  }

  /**
   * Remove a controller from the watchlist
   * @param {string|number} cid - Controller CID
   * @returns {Promise<{success: boolean}>}
   */
  async removeFromWatchlist(cid) {
    return this.request(`/watchlist/${cid}`, {
      method: 'DELETE'
    });
  }

  // ==================== Audit Endpoints ====================

  /**
   * Get visiting controller audit results
   * @returns {Promise<{active: Array, completed: Array, stats: object}>}
   */
  async getVisitingAudit() {
    return this.request('/audit/visiting');
  }

  /**
   * Get local controller audit results
   * @returns {Promise<{active: Array, completed: Array, stats: object}>}
   */
  async getLocalAudit() {
    return this.request('/audit/local');
  }

  /**
   * Run a manual audit for a controller
   * @param {'visiting'|'local'} type - Audit type
   * @param {string|number} cid - Controller CID
   * @returns {Promise<{success: boolean, auditId: string}>}
   */
  async runAudit(type, cid) {
    return this.request('/audit/run', {
      method: 'POST',
      body: JSON.stringify({ type, cid: String(cid) })
    });
  }

  // ==================== Presence Endpoints ====================

  /**
   * Get currently online controllers
   * @returns {Promise<{online: Array}>}
   */
  async getPresence() {
    return this.request('/presence');
  }

  // ==================== Stats Endpoints ====================

  /**
   * Get dashboard statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    return this.request('/stats');
  }
}

// Export singleton instance
export default new WatchlistAPI();
