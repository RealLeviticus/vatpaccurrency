/**
 * KV Reader Worker
 * Read-only access to VATPAC audit data stored in Cloudflare KV
 *
 * Endpoints:
 * - GET /api/kv - Retrieve all audit data (visiting and local)
 * - GET /health - Health check endpoint
 *
 * KV Binding Required:
 * - hours: vatpac-audits namespace
 */

// ==================== Observability Logger ====================
const logger = {
  info: (message, data = {}) => {
    console.log(JSON.stringify({ level: 'INFO', worker: 'kv-reader', timestamp: new Date().toISOString(), message, ...data }));
  },
  warn: (message, data = {}) => {
    console.warn(JSON.stringify({ level: 'WARN', worker: 'kv-reader', timestamp: new Date().toISOString(), message, ...data }));
  },
  error: (message, error = null, data = {}) => {
    console.error(JSON.stringify({
      level: 'ERROR',
      worker: 'kv-reader',
      timestamp: new Date().toISOString(),
      message,
      error: error?.message || error || null,
      stack: error?.stack || null,
      ...data
    }));
  },
  metric: (name, value, tags = {}) => {
    console.log(JSON.stringify({ level: 'METRIC', worker: 'kv-reader', timestamp: new Date().toISOString(), metric: name, value, ...tags }));
  }
};

const ALLOWED_ORIGINS = [
  'https://controllerstats.actuallyleviticus.xyz',
  'https://realleviticus.github.io'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

/**
 * Get the appropriate CORS origin for the request
 */
function getOrigin(request) {
  const reqOrigin = request.headers.get('Origin');
  return (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) ? reqOrigin : ALLOWED_ORIGINS[0];
}

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      ...CORS_HEADERS
    }
  });
}

/**
 * Handle CORS preflight requests
 */
function handleOptions(origin) {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': origin,
      ...CORS_HEADERS
    }
  });
}

/**
 * Get audit data from KV store
 */
async function getKVData(env, origin) {
  // Validate KV binding exists
  if (!env.hours) {
    logger.error('KV binding "hours" is not configured');
    return jsonResponse({
      error: 'KV binding not configured',
      hint: 'Bind the vatpac-audits KV namespace to this worker with binding name "hours"'
    }, 503, origin);
  }

  try {
    const store = await env.hours.get('hours', { type: 'json' });

    // Return empty structure if store not initialized
    if (!store) {
      logger.warn('KV store is empty - returning default structure');
      return jsonResponse({
        visiting: [],
        local: [],
        lastRun: null,
        batchProgress: { visitingOffset: 0, localOffset: 0 },
        initFlags: { visitingInit: false, localInit: false }
      }, 200, origin);
    }

    logger.info('KV data retrieved', { visitingCount: store.visiting?.length || 0, localCount: store.local?.length || 0 });

    // Return store data with defaults for missing fields
    return jsonResponse({
      visiting: store.visiting || [],
      local: store.local || [],
      lastRun: store.lastRun || null,
      batchProgress: store.batchProgress || { visitingOffset: 0, localOffset: 0 },
      initFlags: store.initFlags || { visitingInit: false, localInit: false }
    }, 200, origin);

  } catch (err) {
    logger.error('KV read error', err);
    return jsonResponse({
      error: 'Failed to read KV store'
    }, 500, origin);
  }
}

/**
 * Health check endpoint
 */
function handleHealth(origin) {
  return jsonResponse({
    status: 'ok',
    timestamp: new Date().toISOString(),
    worker: 'kv-reader'
  }, 200, origin);
}

/**
 * Get StatSim sessions data from KV
 */
async function getStatSimData(env, origin) {
  // Try sessions binding first, then hours
  const kv = env?.sessions || env?.hours;
  if (!kv) {
    return jsonResponse({
      error: 'KV binding not configured for StatSim data',
      hint: 'Bind the vatpac-audits KV namespace with binding name "sessions" or "hours"'
    }, 503, origin);
  }

  try {
    const stored = await kv.get('statsim:sessions', { type: 'json' });
    if (!stored) {
      return jsonResponse({
        error: 'StatSim data not found',
        hint: 'Run the statsimscrape worker /trigger endpoint first'
      }, 404, origin);
    }

    logger.info('StatSim data retrieved', { savedAt: stored.savedAt, totalCallsigns: stored.payload?.totalCallsigns });

    return jsonResponse({
      totalCallsigns: stored.payload?.totalCallsigns,
      successes: stored.payload?.successes,
      failures: stored.payload?.failures,
      inProgress: stored.payload?.inProgress || false,
      processed: stored.payload?.processed,
      // Include session data for consumption
      data: stored.payload?.data || [],
      errors: stored.payload?.errors || []
    }, 200, origin);

  } catch (err) {
    logger.error('StatSim KV read error', err);
    return jsonResponse({
      error: 'Failed to read StatSim data'
    }, 500, origin);
  }
}

/**
 * Main request handler
 */
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = getOrigin(request);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return handleOptions(origin);
  }

  // Only allow GET requests
  if (request.method !== 'GET') {
    return jsonResponse({
      error: 'Method not allowed',
      allowed: ['GET', 'OPTIONS']
    }, 405, origin);
  }

  // Route requests
  switch (url.pathname) {
    case '/api/kv':
      return getKVData(env, origin);

    case '/api/statsim':
      return getStatSimData(env, origin);

    case '/health':
      return handleHealth(origin);

    default:
      return jsonResponse({
        error: 'Not found',
        path: url.pathname
      }, 404, origin);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      logger.error('Unhandled error', err, { path: new URL(request.url).pathname });
      return jsonResponse(
        { error: 'Internal server error', message: err.message },
        500,
        getOrigin(request)
      );
    }
  }
};
