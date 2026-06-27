/**
 * VATPAC Controller Audits - Cloudflare Worker
 * REST API for GitHub Pages frontend
 * Runs daily to flag controllers not meeting requirements
 *
 * Requirements:
 * - Visiting: 3 hours per 3 months
 * - Local: Once per 12 months
 */

const VATSIM_DATA_URL = "https://data.vatsim.net/v3/vatsim-data.json";

// ==================== Observability Logger ====================
const logger = {
	info: (message, data = {}) => {
		console.log(JSON.stringify({ level: 'INFO', worker: 'audit', timestamp: new Date().toISOString(), message, ...data }));
	},
	warn: (message, data = {}) => {
		console.warn(JSON.stringify({ level: 'WARN', worker: 'audit', timestamp: new Date().toISOString(), message, ...data }));
	},
	error: (message, error = null, data = {}) => {
		console.error(JSON.stringify({
			level: 'ERROR',
			worker: 'audit',
			timestamp: new Date().toISOString(),
			message,
			error: error?.message || error || null,
			stack: error?.stack || null,
			...data
		}));
	},
	metric: (name, value, tags = {}) => {
		console.log(JSON.stringify({ level: 'METRIC', worker: 'audit', timestamp: new Date().toISOString(), metric: name, value, ...tags }));
	}
};

// Requirements
const VISITING_HOURS_REQUIRED = 3;  // 3 hours per 3 months
const LOCAL_MONTHS_REQUIRED = 12;   // Once per 12 months
const MONTHS_LOOKBACK = 3;

// Rate limiting and batch processing constants
const MAX_RETRIES = 2;                   // Reduced retries to save subrequests
const TMS_CACHE_TTL_MS = 5 * 60 * 1000;  // TMS cache TTL (5 minutes)

// Discord notification
const DISCORD_ROLE_ID = '1447275288152248360';

// VATSIM rating numeric IDs
const RATING_MAP = {
  1: 'OBS', 2: 'S1', 3: 'S2', 4: 'S3', 5: 'C1',
  7: 'C3', 8: 'I1', 10: 'I3', 11: 'SUP', 12: 'ADM'
};

const ACTIVE_ENDORSEMENT_STATUS = 2;
const SOLO_ENDORSEMENT_STATUS = 1;
const ENR_SOLO_ENDORSEMENT_SKU = 'enr';
const TMA_SOLO_ENDORSEMENT_SKU = 'tma';

// Minimum rating required for each position suffix
function getMinRatingForPosition(callsign) {
  const cs = callsign.toUpperCase();
  if (cs.endsWith('_DEL') || cs.endsWith('_GND')) return 2; // S1
  if (cs.endsWith('_TWR')) return 3; // S2
  if (cs.endsWith('_APP') || cs.endsWith('_DEP')) return 4; // S3
  if (cs.endsWith('_CTR') || cs.endsWith('_FSS') || cs.endsWith('_FMP')) return 5; // C1
  return 1; // OBS
}

function isEnroutePosition(callsign) {
  const cs = String(callsign || '').toUpperCase();
  return cs.endsWith('_CTR') || cs.endsWith('_FSS');
}

function isApproachPosition(callsign) {
  const cs = String(callsign || '').toUpperCase();
  return cs.endsWith('_APP') || cs.endsWith('_DEP');
}

function hasValidTmaSoloEndorsement(endorsementsByCid, cid, callsign, now = Date.now()) {
  if (!isApproachPosition(callsign)) return false;
  const endorsements = endorsementsByCid.get(String(cid)) || [];
  return endorsements.some(e => {
    const expiresAt = Date.parse(e?.expires || '');
    const isExpired = Number.isFinite(expiresAt) && expiresAt <= now;
    return String(e?.sku || '').toLowerCase() === TMA_SOLO_ENDORSEMENT_SKU
      && Number(e?.status) === SOLO_ENDORSEMENT_STATUS
      && !isExpired;
  });
}

function hasFullTmaEndorsement(endorsementsByCid, cid) {
  const endorsements = endorsementsByCid.get(String(cid)) || [];
  return endorsements.some(e =>
    String(e?.sku || '').toLowerCase() === TMA_SOLO_ENDORSEMENT_SKU
    && Number(e?.status) === ACTIVE_ENDORSEMENT_STATUS
  );
}

function hasValidEnrSoloEndorsement(endorsementsByCid, cid, callsign, now = Date.now()) {
  const normalizedCallsign = String(callsign || '').toUpperCase();
  if (!isEnroutePosition(normalizedCallsign)) return false;

  const endorsements = endorsementsByCid.get(String(cid)) || [];
  return endorsements.some(endorsement => {
    const sku = String(endorsement?.sku || '').toLowerCase();
    const status = Number(endorsement?.status);
    const expiresAt = Date.parse(endorsement?.expires || '');
    const isExpired = Number.isFinite(expiresAt) && expiresAt <= now;

    return sku === ENR_SOLO_ENDORSEMENT_SKU
      && status === SOLO_ENDORSEMENT_STATUS
      && !isExpired;
  });
}

// Cooldown per violation to avoid Discord spam (1 hour)
const LIVE_CHECK_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Positions requiring the Sydney Complex (sydTcu) endorsement
const SYD_COMPLEX_POSITIONS = new Set([
  'SY_APP', 'SY-N_APP', 'SY-N_DEP', 'SY_DEP',
  'SY-DE_APP', 'SY-D_APP', 'SY-R_DEP',
  'ML-GUN_CTR', 'ML-BIK_CTR',
  'WS_APP', 'BK_APP', 'RI_APP'
]);

// StatSim sessions cache (loaded from KV)
let STATSIM_SESSIONS_CACHE = null;
let STATSIM_CACHE_TS = 0;
const STATSIM_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ==================== Storage ====================

async function loadStore(env) {
  if (env.hours) {
    try {
      const stored = await env.hours.get('hours', { type: 'json' });
      if (stored) {
        if (!stored.visiting) stored.visiting = [];
        if (!stored.local) stored.local = [];
        if (!stored.batchProgress) stored.batchProgress = { visitingOffset: 0, localOffset: 0 };
        if (!stored.initFlags) stored.initFlags = { visitingInit: false, localInit: false };
        logger.info('Store loaded from KV', { visitingCount: stored.visiting.length, localCount: stored.local.length });
        return stored;
      }
    } catch (e) {
      logger.error('KV read failed', e);
    }
  }
  return { visiting: [], local: [], lastRun: null, batchProgress: { visitingOffset: 0, localOffset: 0 }, initFlags: { visitingInit: false, localInit: false } };
}

async function saveStore(env, data) {
  if (env.hours) {
    try {
      await env.hours.put('hours', JSON.stringify(data));
      logger.info('Store saved to KV', { visitingCount: data.visiting.length, localCount: data.local.length });
    } catch (err) {
      logger.error('KV save failed', err);
    }
  }
}

// ==================== REST API ====================

function jsonResponse(data, status = 200, env = null, request = null) {
  const allowedOrigins = [
    'https://controllerstats.actuallyleviticus.xyz',
    'https://realleviticus.github.io'
  ];

  let origin = 'https://controllerstats.actuallyleviticus.xyz';
  if (request) {
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      origin = requestOrigin;
    }
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

function handleCORS(env, request = null) {
  const allowedOrigins = [
    'https://controllerstats.actuallyleviticus.xyz',
    'https://realleviticus.github.io'
  ];

  let origin = 'https://controllerstats.actuallyleviticus.xyz';
  if (request) {
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      origin = requestOrigin;
    }
  }

  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

async function handleAPI(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    // GET /api/kv - Direct KV access
    if (path === '/api/kv' && method === 'GET') {
      const store = await loadStore(env);
      return jsonResponse({
        visiting: store.visiting || [],
        local: store.local || [],
        lastRun: store.lastRun,
        batchProgress: store.batchProgress,
        initFlags: store.initFlags
      }, 200, env, request);
    }

    // GET /api/audit/visiting
    if (path === '/api/audit/visiting' && method === 'GET') {
      const store = await loadStore(env);
      return jsonResponse({
        active: [],
        completed: store.visiting || [],
        stats: {
          totalActive: 0,
          totalCompleted: store.visiting?.length || 0
        }
      }, 200, env, request);
    }

    // GET /api/audit/local
    if (path === '/api/audit/local' && method === 'GET') {
      const store = await loadStore(env);
      return jsonResponse({
        active: [],
        completed: store.local || [],
        stats: {
          totalActive: 0,
          totalCompleted: store.local?.length || 0
        }
      }, 200, env, request);
    }

    // GET /api/stats
    if (path === '/api/stats' && method === 'GET') {
      const store = await loadStore(env);
      return jsonResponse({
        totalWatched: 0,
        activeAudits: 0,
        completedAudits: (store.visiting?.length || 0) + (store.local?.length || 0),
        lastUpdate: store.lastRun || new Date().toISOString()
      }, 200, env, request);
    }

    // DEBUG: Check KV contents
    if (path === '/api/debug/kv' && method === 'GET') {
      const store = await loadStore(env);
      return jsonResponse({
        hasData: !!store,
        visitingCount: store?.visiting?.length || 0,
        localCount: store?.local?.length || 0,
        lastRun: store?.lastRun,
        batchProgress: store?.batchProgress,
        initFlags: store?.initFlags,
        sampleVisiting: store?.visiting?.slice(0, 2) || [],
        sampleLocal: store?.local?.slice(0, 2) || []
      }, 200, env, request);
    }

    // DEBUG: Reset initialization flags
    if (path === '/api/debug/reset-init' && method === 'POST') {
      const store = await loadStore(env);
      store.initFlags = { visitingInit: false, localInit: false };
      store.batchProgress = { visitingOffset: 0, localOffset: 0 };
      store.visiting = [];
      store.local = [];
      await saveStore(env, store);
      return jsonResponse({
        success: true,
        message: 'Cleared all data. Next run will reinitialize.'
      }, 200, env, request);
    }

    // GET /api/live-check - inspect current online violations (no alerts)
    if (path === '/api/live-check' && method === 'GET') {
      const result = await checkLiveVatsimData(env);
      return jsonResponse(result, 200, env, request);
    }

    // DEBUG: Check TMS data
    if (path === '/api/debug/tms' && method === 'GET') {
      const visitingCids = await getTMSList('visiting');
      const localCids = await getTMSList('local');
      return jsonResponse({
        visiting: {
          count: visitingCids.length,
          sample: visitingCids.slice(0, 10)
        },
        local: {
          count: localCids.length,
          sample: localCids.slice(0, 10)
        }
      }, 200, env, request);
    }

    // DEBUG: Check StatSim sessions data from KV
    if (path === '/api/debug/statsim' && method === 'GET') {
      const statSimData = await loadStatSimSessions(env);
      if (!statSimData) {
        return jsonResponse({
          error: 'StatSim data not available',
          hint: 'Run the statsimscrape worker /trigger endpoint first'
        }, 404, env, request);
      }
      return jsonResponse({
        savedAt: statSimData.savedAt,
        range: statSimData.range,
        callsignCount: statSimData.sessionsMap?.size || 0,
        uniqueCids: statSimData.cidMap?.size || 0,
        totalSessions: statSimData.totalSessions || 0,
        isPartial: statSimData.isPartial || false,
        sampleCallsigns: Array.from(statSimData.sessionsMap?.keys() || []).slice(0, 10)
      }, 200, env, request);
    }

    // DEBUG: Test hours lookup for a specific CID
    if (path.startsWith('/api/debug/hours/') && method === 'GET') {
      const cid = path.replace('/api/debug/hours/', '');
      const statSimData = await loadStatSimSessions(env);
      const visiting3mo = statSimData ? getHoursFromStatSim(cid, statSimData, 3) : null;
      const local12mo = statSimData ? getHoursFromStatSim(cid, statSimData, 12) : null;
      
      // Check requirements (must match runAudit logic exactly)
      const visitingPassed = visiting3mo ? visiting3mo.hours >= VISITING_HOURS_REQUIRED : false;
      const localPassed = local12mo ? local12mo.lastSessionWithinPeriod !== null : false;
      
      return jsonResponse({
        cid,
        statSimAvailable: !!statSimData,
        visiting: {
          lookback: '3 months',
          required: `${VISITING_HOURS_REQUIRED} hours`,
          hours: visiting3mo?.hours ? Math.round(visiting3mo.hours * 100) / 100 : 0,
          sessionCount: visiting3mo?.sessionCount || 0,
          lastSession: visiting3mo?.lastSession || null,
          passed: visitingPassed
        },
        local: {
          lookback: '12 months',
          required: 'At least 1 session',
          hours: local12mo?.hours ? Math.round(local12mo.hours * 100) / 100 : 0,
          sessionCount: local12mo?.sessionCount || 0,
          lastSession: local12mo?.lastSession || null,
          passed: localPassed
        }
      }, 200, env, request);
    }

    return jsonResponse({ error: 'Not Found' }, 404, env, request);

  } catch (error) {
    logger.error('API Error', error, { path: new URL(request.url).pathname, method: request.method });
    return jsonResponse({ error: 'Internal Server Error', message: error?.message }, 500, env, request);
  }
}

// ==================== Audit Logic ====================

// Cache TMS results
let TMS_CACHE = null;
let TMS_CACHE_TS = 0;

async function getTMSList(scope = "visiting") {
  if (TMS_CACHE && (Date.now() - TMS_CACHE_TS) < TMS_CACHE_TTL_MS) {
    const filtered = TMS_CACHE.users.filter(u => (scope === "local" ? TMS_CACHE.isLocal(u) : TMS_CACHE.isVisiting(u)));
    return filtered.map(u => ({
      cid: String(u.cid),
      rating: u.rating?.short || 'N/A'
    })).filter(u => u.cid);
  }

  logger.info('Fetching TMS data', { scope });
  const url = "https://tms-server.vatpac.org/users";
  const pageSize = 200;
  let offset = 0;
  let users = [];

  // Limit TMS fetches to avoid subrequest limits
  const maxPages = 10; // Max 2000 users
  let pageCount = 0;

  while (pageCount < maxPages) {
    try {
      const r = await fetch(`${url}?limit=${pageSize}&offset=${offset}`, {
        headers: { "User-Agent": "VATPAC-Audit-Worker" }
      });
      if (!r.ok) {
        logger.warn('TMS fetch failed', { status: r.status, offset });
        break;
      }
      const j = await r.json();
      const chunk = Array.isArray(j?.data) ? j.data : [];
      users = users.concat(chunk);
      logger.info('TMS page fetched', { page: pageCount + 1, chunkSize: chunk.length, totalUsers: users.length });
      if (chunk.length < pageSize) break;
      offset += pageSize;
      pageCount++;
    } catch (err) {
      logger.error('TMS fetch error', err, { pageCount, offset });
      break;
    }
  }

  // Robust scope detection
  function isLocal(u) {
    const divisionId = String(u?.division?.id || "").toUpperCase();
    const typeStr = String(u?.type || "").toLowerCase();
    const localFlag = u?.local === true || u?.is_local === true;
    return divisionId === "PAC" || localFlag || /local/.test(typeStr);
  }

  // Divisions excluded from visiting controller checks
  const EXCLUDED_VISITING_DIVISIONS = new Set(["NZ"]);

  function isVisiting(u) {
    const divisionId = String(u?.division?.id || "").toUpperCase();
    if (EXCLUDED_VISITING_DIVISIONS.has(divisionId)) return false;
    const typeStr = String(u?.type || "").toLowerCase();
    const visitingFlag = u?.local === false || u?.is_local === false || u?.is_visiting === true;
    return divisionId !== "PAC" || visitingFlag || /visit/.test(typeStr);
  }

  TMS_CACHE = { users, isLocal, isVisiting };
  TMS_CACHE_TS = Date.now();

  const filtered = users.filter(u => (scope === "local" ? isLocal(u) : isVisiting(u)));
  const usersWithRating = filtered.map(u => ({
    cid: String(u.cid),
    rating: u.rating?.short || 'N/A',
    division: String(u?.division?.id || '').toUpperCase()
  })).filter(u => u.cid);

  logger.info('TMS data loaded', {
    totalUsers: users.length,
    localCount: users.filter(isLocal).length,
    visitingCount: users.filter(isVisiting).length,
    scopeFiltered: usersWithRating.length,
    scope
  });
  return usersWithRating;
}

async function ensureTMSCache() {
  if (!TMS_CACHE || (Date.now() - TMS_CACHE_TS) >= TMS_CACHE_TTL_MS) {
    await getTMSList('local');
  }
}

// Returns Map<cid, Set<sku>> of full active (status 2) endorsements for all TMS users
async function getTMSEndorsementMap() {
  // Populate cache if stale/empty (piggybacks on existing getTMSList cache)
  await ensureTMSCache();
  const map = new Map();
  if (!TMS_CACHE?.users) return map;
  for (const user of TMS_CACHE.users) {
    const cid = String(user.cid || '');
    if (!cid) continue;
    const active = new Set(
      (user.endorsements || []).filter(e => Number(e.status) === ACTIVE_ENDORSEMENT_STATUS).map(e => e.sku)
    );
    map.set(cid, active);
  }
  return map;
}

// Returns Map<cid, endorsements[]> with raw TMS endorsement details, including solos.
async function getTMSEndorsementsByCid() {
  await ensureTMSCache();
  const map = new Map();
  if (!TMS_CACHE?.users) return map;
  for (const user of TMS_CACHE.users) {
    const cid = String(user.cid || '');
    if (!cid) continue;
    map.set(cid, Array.isArray(user.endorsements) ? user.endorsements : []);
  }
  return map;
}

// VATPAC callsigns - auto-synced from vatSys datasets
// To update, run: node scripts/sync-positions.js
import { VATPAC_CALLSIGNS as SYNCED_CALLSIGNS } from './positions.js';

// Fallback hardcoded callsigns in case positions.js import fails
const FALLBACK_CALLSIGNS = new Set([
  'AD_DEL', 'AD_GND', 'AD_TWR', 'AY_GND', 'AY_TWR', 'AS_TWR', 'AMB_DEL', 'AMB_GND', 'AMB_TWR',
  'AF_GND', 'AF_TWR', 'AV_TWR', 'BK_GND', 'BK_TWR', 'BN_DEL', 'BN_GND', 'BN_TWR',
  'BRM_GND', 'BRM_TWR', 'CS_DEL', 'CS_GND', 'CS_TWR', 'CN_GND', 'CN_TWR', 'CB_GND', 'CB_TWR',
  'CFS_TWR', 'CIN_DEL', 'CIN_GND', 'CIN_TWR', 'DN_DEL', 'DN_GND', 'DN_TWR',
  'ES_DEL', 'ES_GND', 'ES_TWR', 'ED_GND', 'ED_TWR', 'EN_GND', 'EN_TWR',
  'GIG_GND', 'GIG_TWR', 'CG_DEL', 'CG_GND', 'CG_TWR', 'HM_TWR', 'HB_GND', 'HB_TWR',
  'JT_GND', 'JT_TWR', 'KA_GND', 'KA_TWR', 'LT_TWR', 'LM_GND', 'LM_TWR',
  'MK_GND', 'MK_TWR', 'ML_DEL', 'ML_GND', 'ML_TWR', 'MB_GND', 'MB_TWR',
  'NW_DEL', 'NW_GND', 'NW_TWR', 'OK_DEL', 'OK_GND', 'OK_TWR', 'PF_GND', 'PF_TWR',
  'PE_DEL', 'PE_GND', 'PE_TWR', 'PH_DEL', 'PH_GND', 'PH_TWR',
  'RI_GND', 'RI_TWR', 'RK_GND', 'RK_TWR', 'SG_GND', 'SG_TWR',
  'SU_GND', 'SU_TWR', 'SY_DEL', 'SY_GND', 'SY_TWR', 'TW_GND', 'TW_TWR',
  'TN_DEL', 'TN_GND', 'TN_TWR', 'TL_DEL', 'TL_GND', 'TL_TWR',
  'WLM_DEL', 'WLM_GND', 'WLM_TWR', 'WR_TWR',
  'AF-N_TWR', 'BK-C_TWR', 'BN-N_GND', 'BN-S_GND', 'BN-W_TWR', 'JT-C_TWR', 'MB-W_TWR',
  'PF-W_TWR', 'PH-E_GND', 'SY-C_GND', 'SY-W_GND', 'SY-E_TWR', 'TW-S_TWR',
  'AD_APP', 'AMB_APP', 'BN_APP', 'CS_APP', 'CB_APP', 'CIN_APP', 'DN_APP', 'ES_APP',
  'HB_APP', 'LT_APP', 'LM_APP', 'MK_APP', 'ML_APP', 'NW_APP', 'OK_APP', 'PE_APP',
  'PH_APP', 'RK_APP', 'SG_APP', 'SY_APP', 'TN_APP', 'TL_APP', 'WLM_APP',
  'AD-W_APP', 'AD-R_DEP', 'AD_FMP', 'BN-C_APP', 'BN-S_APP', 'BN_DEP', 'BN-S_DEP', 'BN-R_DEP', 'BN_FMP',
  'CS-W_APP', 'CS_FMP', 'CB-W_APP', 'DN-W_APP', 'AV_APP', 'ML_DEP', 'ML-S_DEP', 'ML-R_DEP', 'ML_FMP',
  'PH_DEP', 'PH-R_DEP', 'PH_FMP', 'SY-N_APP', 'SY_DEP', 'SY-S_DEP', 'SY-DE_APP', 'SY-D_APP',
  'SY_FMP', 'SY-R_DEP', 'WLM-L_APP',
  'BN-ARL_CTR', 'BN-HWE_CTR', 'BN-INL_CTR', 'BN-ISA_CTR', 'BN-KEN_CTR', 'BN-KPL_CTR', 'BN-TRT_CTR',
  'ML-IND_FSS', 'BN-TSN_FSS', 'ML-ASP_CTR', 'ML-BLA_CTR', 'ML-GUN_CTR', 'ML-HUO_CTR', 'ML-HYD_CTR',
  'ML-MUN_CTR', 'ML-OLW_CTR', 'ML-TBD_CTR', 'ML-WOL_CTR',
  'BN-ARA_CTR', 'BN-ASH_CTR', 'BN-BAR_CTR', 'BN-BUR_CTR', 'BN-CVN_CTR', 'BN-CNK_CTR', 'BN-DOS_CTR',
  'BN-GOL_CTR', 'BN-KIY_CTR', 'BN-MLD_CTR', 'BN-MNN_CTR', 'BN-MDE_CTR', 'BN-NSA_CTR', 'BN-OCN_CTR',
  'BN-SDY_CTR', 'BN-STR_CTR', 'BN-SWY_CTR', 'BN-TBP_CTR', 'BN-TRS_CTR', 'BN-WIL_CTR', 'BN-WEG_CTR',
  'BN-COL_FSS', 'BN-FLD_FSS', 'ML-INE_FSS', 'ML-INS_FSS', 'ML-ASW_CTR', 'ML-AUG_CTR', 'ML-BIK_CTR',
  'ML-BKE_CTR', 'ML-CRS_CTR', 'ML-ELW_CTR', 'ML-ESP_CTR', 'ML-FOR_CTR', 'ML-GEL_CTR', 'ML-GTH_CTR',
  'ML-GVE_CTR', 'ML-JAR_CTR', 'ML-KAT_CTR', 'ML-LEA_CTR', 'ML-MEK_CTR', 'ML-MZI_CTR', 'ML-MTK_CTR',
  'ML-NEW_CTR', 'ML-OXL_CTR', 'ML-PAR_CTR', 'ML-PIY_CTR', 'ML-POT_CTR', 'ML-SNO_CTR', 'ML-WAR_CTR',
  'ML-WON_CTR', 'ML-WRA_CTR', 'ML-YWE_CTR',
  'NFFN_APP', 'NFFJ_CTR', 'NFFN_CTR', 'NFFF_FSS', 'NFFN_TWR', 'NFFN_GND', 'NFNA_APP', 'NFNA_TWR', 'NFNA_GND', 'NFFN_DEL',
  'PKWA_GND', 'PKWA_TWR', 'PKWA_APP', 'KWA_TWR', 'KWA_GND',
  'NWWM_TWR', 'NWWM_GND', 'NWWW_APP', 'NWWW_TWR', 'NWWW_GND', 'NWWW_CTR', 'NWWW-T_APP',
  'AYGA_TWR', 'AYMD_TWR', 'AYMH_TWR', 'AYNZ_APP', 'AYNZ_TWR', 'AYPY_APP', 'AYPM_CTR',
  'AYPY_GND', 'AYPY_TWR', 'AYTK_TWR',
  'NVVV_APP', 'NVVV_TWR', 'NVVV_CTR',
  'SY-C_DEP'
]);

// Use synced callsigns if available, otherwise fall back to hardcoded
const VATPAC_CALLSIGNS = (SYNCED_CALLSIGNS && SYNCED_CALLSIGNS.size > 0) ? SYNCED_CALLSIGNS : FALLBACK_CALLSIGNS;

// Load StatSim sessions from the shared KV binding (sessions -> statsim:sessions)
// Builds both a callsign map and a CID-indexed map for O(1) lookups
async function loadStatSimSessions(env) {
  // Return cache if still valid
  if (STATSIM_SESSIONS_CACHE && (Date.now() - STATSIM_CACHE_TS) < STATSIM_CACHE_TTL_MS) {
    return STATSIM_SESSIONS_CACHE;
  }

  // Try to load from KV (sessions binding -> vatpac-audits namespace)
  const kv = env?.sessions || env?.hours;
  if (!kv) {
    logger.warn('No KV binding found for StatSim sessions');
    return null;
  }

  try {
    const stored = await kv.get('statsim:sessions', { type: 'json' });
    if (stored?.payload?.data) {
      // Build callsign map AND CID-indexed map in a single pass
      const sessionsMap = new Map();
      const cidMap = new Map(); // CID -> array of sessions (for O(1) lookups)
      let totalSessions = 0;

      for (const callsignEntry of stored.payload.data) {
        if (callsignEntry.ok && Array.isArray(callsignEntry.data)) {
          sessionsMap.set(callsignEntry.callsign, callsignEntry.data);

          // Index every session by CID for fast lookups
          for (const session of callsignEntry.data) {
            const cid = String(session.vatsimid || session.cid || '').trim();
            if (!cid) continue;
            if (!cidMap.has(cid)) {
              cidMap.set(cid, []);
            }
            cidMap.get(cid).push(session);
            totalSessions++;
          }
        }
      }

      // Warn if data appears incomplete
      const isPartial = stored.payload.inProgress === true;
      const expectedCallsigns = stored.payload.totalCallsigns || 0;
      if (isPartial) {
        logger.warn('StatSim data is still in-progress — audit results may be incomplete', {
          callsignsLoaded: sessionsMap.size,
          expectedCallsigns
        });
      }

      STATSIM_SESSIONS_CACHE = {
        sessionsMap,
        cidMap,
        savedAt: stored.savedAt,
        range: stored.payload.range,
        isPartial,
        totalSessions
      };
      STATSIM_CACHE_TS = Date.now();
      logger.info('StatSim sessions loaded from KV', {
        callsignCount: sessionsMap.size,
        uniqueCids: cidMap.size,
        totalSessions,
        savedAt: stored.savedAt,
        isPartial
      });
      return STATSIM_SESSIONS_CACHE;
    }
  } catch (err) {
    logger.error('Failed to load StatSim sessions from KV', err);
  }

  return null;
}

// Get hours and last session for a CID from StatSim data
// Uses CID-indexed map for O(1) lookup instead of scanning all sessions
// StatSim session format: { id, callsign, vatsimid, loggedOn, loggedOff }
function getHoursFromStatSim(cid, statSimData, monthsBack = 3) {
  const cidStr = String(cid).trim();
  if (!statSimData?.cidMap) {
    // Fallback to legacy sessionsMap scan if cidMap not available
    if (!statSimData?.sessionsMap) return null;
    return _getHoursFromStatSimLegacy(cidStr, statSimData, monthsBack);
  }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
  const cutoff = cutoffDate.getTime();

  let totalMinutes = 0;
  let lastSessionStart = null;
  let absoluteLastSession = null;
  let sessionCount = 0;

  // O(1) lookup by CID — only iterate this controller's sessions
  const sessions = statSimData.cidMap.get(cidStr);
  if (!sessions || sessions.length === 0) {
    return {
      hours: 0,
      lastSession: null,
      lastSessionWithinPeriod: null,
      sessionCount: 0
    };
  }

  for (const session of sessions) {
    const startMs = Date.parse(session.loggedOn || session.start);
    const endMs = Date.parse(session.loggedOff || session.end);

    if (!startMs || !isFinite(startMs)) continue;

    // Track absolute last session (regardless of time period)
    if (!absoluteLastSession || startMs > absoluteLastSession) {
      absoluteLastSession = startMs;
    }

    // Check if session is within the lookback period
    if (startMs >= cutoff || (endMs && endMs >= cutoff)) {
      if (endMs && isFinite(endMs) && endMs > startMs) {
        const durationMinutes = (endMs - startMs) / 1000 / 60;
        totalMinutes += durationMinutes;
        sessionCount++;
      }

      if (!lastSessionStart || startMs > lastSessionStart) {
        lastSessionStart = startMs;
      }
    }
  }

  return {
    hours: totalMinutes / 60,
    lastSession: absoluteLastSession ? new Date(absoluteLastSession).toISOString() : null,
    lastSessionWithinPeriod: lastSessionStart ? new Date(lastSessionStart).toISOString() : null,
    sessionCount
  };
}

// Legacy fallback: scan all callsigns×sessions (only used if cidMap unavailable)
function _getHoursFromStatSimLegacy(cidStr, statSimData, monthsBack) {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
  const cutoff = cutoffDate.getTime();

  let totalMinutes = 0;
  let lastSessionStart = null;
  let absoluteLastSession = null;
  let sessionCount = 0;

  for (const [, sessions] of statSimData.sessionsMap) {
    if (!Array.isArray(sessions)) continue;
    for (const session of sessions) {
      const sessionCid = String(session.vatsimid || session.cid || '').trim();
      if (sessionCid !== cidStr) continue;

      const startMs = Date.parse(session.loggedOn || session.start);
      const endMs = Date.parse(session.loggedOff || session.end);
      if (!startMs || !isFinite(startMs)) continue;

      if (!absoluteLastSession || startMs > absoluteLastSession) {
        absoluteLastSession = startMs;
      }

      if (startMs >= cutoff || (endMs && endMs >= cutoff)) {
        if (endMs && isFinite(endMs) && endMs > startMs) {
          totalMinutes += (endMs - startMs) / 1000 / 60;
          sessionCount++;
        }
        if (!lastSessionStart || startMs > lastSessionStart) {
          lastSessionStart = startMs;
        }
      }
    }
  }

  return {
    hours: totalMinutes / 60,
    lastSession: absoluteLastSession ? new Date(absoluteLastSession).toISOString() : null,
    lastSessionWithinPeriod: lastSessionStart ? new Date(lastSessionStart).toISOString() : null,
    sessionCount
  };
}

// Get rating for a CID from VATSIM API
async function getRating(cid) {
  const cidStr = String(cid).trim();
  if (!/^\d{3,10}$/.test(cidStr)) {
    return 'N/A';
  }

  try {
    const url = `https://api.vatsim.net/api/ratings/${cidStr}/`;
    const r = await fetch(url, { headers: { "User-Agent": "VATPAC-Audit-Worker" } });
    if (!r.ok) return 'N/A';

    const data = await r.json();
    return data?.rating?.short || data?.short || 'N/A';
  } catch (err) {
    logger.error('Rating fetch error', err, { cid: cidStr });
    return 'N/A';
  }
}

// REMOVED: VATSIM API fallback for last session (too slow)
// Now relies solely on StatSim data loaded from KV

// Get ATC hours - uses StatSim KV data, with VATSIM API as fallback
async function getATCHours(cid, monthsBack = 3, env = null) {
  const cidStr = String(cid).trim();
  if (!/^\d{3,10}$/.test(cidStr)) {
    return { hours: 0, lastSession: null };
  }

  // Try StatSim data first (no subrequest needed if cached)
  if (env) {
    const statSimData = await loadStatSimSessions(env);
    if (statSimData) {
      const result = getHoursFromStatSim(cidStr, statSimData, monthsBack);
      if (result) {
        return result;
      }
    }
  }

  // Fallback to VATSIM API if StatSim data not available
  logger.info('StatSim data not available, falling back to VATSIM API', { cid: cidStr });

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);
  const cutoff = cutoffDate.getTime();
  const url = `https://api.vatsim.net/v2/members/${cidStr}/atc`;

  let retries = 0;
  while (retries <= MAX_RETRIES) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "VATPAC-Audit-Worker" } });

      if (r.status === 429) {
        const backoffMs = Math.pow(2, retries) * 1000;
        logger.warn('VATSIM API rate limited', { cid: cidStr, backoffMs, retryAttempt: retries + 1 });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        retries++;
        continue;
      }

      if (!r.ok) {
        return { hours: 0, lastSession: null };
      }

      const data = await r.json();
      const sessions = data?.items || data?.data || [];

      let totalHours = 0;
      let lastScopeStart = null;
      let absoluteLastSession = null; // Track last session regardless of time period

      for (const session of sessions) {
        const conn = session?.connection_id || session;
        const start = conn.start || session.start;
        const end = conn.end || session.end;
        const callsign = String(conn.callsign || session.callsign || "").toUpperCase();

        if (!start || !end || callsign.endsWith("_ATIS")) continue;

        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (!isFinite(startMs) || !isFinite(endMs)) continue;

        if (!VATPAC_CALLSIGNS.has(callsign)) continue;

        // Track absolute last session (regardless of time period)
        if (!absoluteLastSession || startMs > absoluteLastSession) {
          absoluteLastSession = startMs;
        }

        if (startMs >= cutoff && (!lastScopeStart || startMs > lastScopeStart)) {
          lastScopeStart = startMs;
        }

        if (startMs >= cutoff || endMs >= cutoff) {
          const duration = (endMs - startMs) / 1000 / 3600;
          if (duration > 0) totalHours += duration;
        }
      }

      return {
        hours: totalHours,
        lastSession: absoluteLastSession ? new Date(absoluteLastSession).toISOString() : null
      };

    } catch (error) {
      logger.error('VATSIM API fetch error', error, { cid: cidStr, retryAttempt: retries + 1 });
      if (retries < MAX_RETRIES) {
        retries++;
      } else {
        return { hours: 0, lastSession: null };
      }
    }
  }

  return { hours: 0, lastSession: null };
}

async function runAudit(env, store, type) {
  logger.info('Starting audit', { type });

  const allCids = await getTMSList(type);
  logger.info('TMS list retrieved', { type, count: allCids.length });

  const isLocal = type === "local";
  const dataKey = isLocal ? 'local' : 'visiting';

  // Load StatSim data once at the start (cached in memory)
  const statSimData = await loadStatSimSessions(env);
  if (!statSimData || !statSimData.cidMap || statSimData.cidMap.size === 0) {
    logger.error('StatSim data not available or empty — aborting audit to prevent false flags', {
      type,
      hasData: !!statSimData,
      cidMapSize: statSimData?.cidMap?.size || 0,
      sessionsMapSize: statSimData?.sessionsMap?.size || 0
    });
    return {
      processed: 0,
      total: allCids.length,
      flagged: 0,
      passed: 0,
      skipped: true,
      reason: 'StatSim data not available or empty — audit skipped to prevent false flags'
    };
  }

  // Check data freshness — warn if older than 36 hours
  const savedAt = statSimData.savedAt ? new Date(statSimData.savedAt) : null;
  const ageHours = savedAt ? (Date.now() - savedAt.getTime()) / 1000 / 3600 : null;
  if (ageHours && ageHours > 36) {
    logger.warn('StatSim data is stale — may produce inaccurate results', {
      savedAt: statSimData.savedAt,
      ageHours: Math.round(ageHours),
      isPartial: statSimData.isPartial
    });
  }
  if (statSimData.isPartial) {
    logger.warn('StatSim data is incomplete — scrape still in progress', {
      callsignCount: statSimData.sessionsMap?.size || 0,
      uniqueCids: statSimData.cidMap?.size || 0
    });
  }

  logger.info('Processing all CIDs at once (no batching needed - KV lookup is synchronous)', { 
    type, 
    count: allCids.length,
    statSimAvailable: !!statSimData 
  });

  const results = [];

  // Process all CIDs - no batching needed since we're just doing in-memory lookups
  for (const user of allCids) {
    // Check if local controller is not in PAC division
    const isPACMember = !user.division || user.division === '' || user.division === 'PAC';
    if (isLocal && !isPACMember) {
      results.push({
        id: `audit_${user.cid}`,
        type,
        status: "not-division-member",
        rating: user.rating,
        division: user.division,
        hoursLogged: 0,
        lastSession: null,
        flagged: true
      });
      continue;
    }

    // Get hours from StatSim KV data (synchronous in-memory lookup)
    const data = statSimData
      ? getHoursFromStatSim(user.cid, statSimData, isLocal ? LOCAL_MONTHS_REQUIRED : MONTHS_LOOKBACK)
      : { hours: 0, lastSession: null, lastSessionWithinPeriod: null, sessionCount: 0 };

    // Use lastSession from StatSim only (no VATSIM API fallback for performance)
    const lastSession = data?.lastSession || null;

    // For local controllers: check if they have a session within the 12-month period
    // For visiting controllers: check if they have >= required hours within the 3-month period
    const passed = isLocal
      ? data?.lastSessionWithinPeriod !== null
      : (data?.hours || 0) >= VISITING_HOURS_REQUIRED;

    results.push({
      id: `audit_${user.cid}`,
      type,
      status: passed ? "completed" : "flagged",
      rating: user.rating,
      division: user.division,
      hoursLogged: Math.round((data?.hours || 0) * 10) / 10,
      lastSession: lastSession,
      flagged: !passed
    });
  }

  // Replace all data for this type
  store[dataKey] = results;
  store.lastRun = new Date().toISOString();
  
  await saveStore(env, store);
  
  logger.info('Audit complete', { type, processed: results.length, flagged: results.filter(r => r.flagged).length });
  logger.metric('audit_complete', 1, { type, processed: results.length, flagged: results.filter(r => r.flagged).length });

  return {
    processed: results.length,
    total: allCids.length,
    flagged: results.filter(r => r.flagged).length,
    passed: results.filter(r => !r.flagged).length
  };
}

async function runDailyAudit(env) {
  logger.info('Starting daily audit');

  try {
    // Run visiting audit
    let store = await loadStore(env);
    const visitingResult = await runAudit(env, store, "visiting");

    // If visiting audit was skipped due to missing data, abort the whole daily audit
    if (visitingResult.skipped) {
      logger.warn('Daily audit aborted — StatSim data not available', { reason: visitingResult.reason });
      return { skipped: true, reason: visitingResult.reason };
    }

    // Reload store to get the saved visiting data, then run local audit
    store = await loadStore(env);
    const localResult = await runAudit(env, store, "local");

    if (localResult.skipped) {
      logger.warn('Local audit skipped — StatSim data not available', { reason: localResult.reason });
    }

    // Enrich flagged controllers with accurate VATSIM last session dates
    let enrichmentStats = {};
    try {
      enrichmentStats = await enrichFlaggedWithVatsimLastSession(env);
    } catch (e) {
      enrichmentStats = { error: e.message };
      logger.error('Enrichment failed (non-fatal)', e);
    }

    // Reload store after enrichment
    const finalStore = await loadStore(env);

    logger.info('Daily audit complete', {
      visitingCount: finalStore.visiting?.length || 0,
      localCount: finalStore.local?.length || 0,
      visitingFlagged: visitingResult.flagged,
      localFlagged: localResult.flagged
    });
    logger.metric('daily_audit_complete', 1, {
      visiting: finalStore.visiting?.length || 0,
      local: finalStore.local?.length || 0
    });

    // Send Discord alert for flagged controllers
    await sendDiscordAuditAlert(env, finalStore);

    return {
      visiting: visitingResult,
      local: localResult,
      enrichment: enrichmentStats,
      finalCounts: {
        visiting: finalStore.visiting?.length || 0,
        local: finalStore.local?.length || 0
      }
    };

  } catch (error) {
    logger.error('Daily audit failed', error);
    throw error;
  }
}

// ==================== VATSIM Last Session Enrichment ====================

const VATSIM_ENRICHMENT_BATCH_SIZE = 15;
const VATSIM_DELAY_MS = 1500; // 1.5s between requests to avoid VATSIM API rate limiting
const VATSIM_CACHE_KEY = 'vatsim_last_sessions';

async function fetchVatsimLastSession(cid) {
  const url = `https://api.vatsim.net/v2/members/${cid}/atc?limit=1`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'VATPAC-Audit-Worker' } });
    if (!r.ok) return { _failed: true, status: r.status };
    const data = await r.json();
    const item = data?.items?.[0];
    if (!item) return { lastSession: null, lastCallsign: null };
    const conn = item.connection_id || item;
    const start = conn.start || item.start;
    const callsign = String(conn.callsign || item.callsign || '').toUpperCase();
    if (!start) return { lastSession: null, lastCallsign: null };
    return { lastSession: start, lastCallsign: callsign };
  } catch (e) {
    return { _failed: true, error: e.message };
  }
}

async function enrichFlaggedWithVatsimLastSession(env) {
  const store = await loadStore(env);
  const allRecords = [...(store.visiting || []), ...(store.local || [])];
  const flagged = allRecords.filter(r => r.flagged);

  if (flagged.length === 0) {
    logger.info('No flagged controllers to enrich');
    return 0;
  }

  // Load persistent VATSIM cache from KV
  let vatsimCache = {};
  try {
    vatsimCache = await env.hours.get(VATSIM_CACHE_KEY, { type: 'json' }) || {};
  } catch { /* start fresh */ }

  // Find flagged controllers not yet in the cache
  const needsLookup = flagged.filter(r => {
    const cid = r.id.replace('audit_', '');
    return !vatsimCache[cid];
  });

  logger.info('Enriching flagged controllers with VATSIM last session', {
    totalFlagged: flagged.length,
    alreadyCached: flagged.length - needsLookup.length,
    needsLookup: needsLookup.length
  });

  // Fetch un-cached controllers sequentially to avoid VATSIM API rate limits
  let fetched = 0;
  let rateLimited = 0;
  const failures = [];
  const toFetch = needsLookup.slice(0, VATSIM_ENRICHMENT_BATCH_SIZE);
  if (toFetch.length > 0) {
    for (const record of toFetch) {
      const cid = record.id.replace('audit_', '');
      const vatsimData = await fetchVatsimLastSession(cid);
      if (vatsimData && !vatsimData._failed) {
        vatsimCache[cid] = {
          lastSession: vatsimData.lastSession,
          lastCallsign: vatsimData.lastCallsign,
          fetchedAt: new Date().toISOString()
        };
        fetched++;
      } else {
        rateLimited++;
        if (vatsimData?._failed) {
          failures.push({ cid, status: vatsimData.status, error: vatsimData.error });
        }
      }
      // Delay between requests to respect VATSIM API rate limits
      if (toFetch.indexOf(record) < toFetch.length - 1) {
        await new Promise(r => setTimeout(r, VATSIM_DELAY_MS));
      }
    }

    logger.info('VATSIM fetch batch results', { fetched, rateLimited, attempted: toFetch.length, sampleFailures: failures.slice(0, 5) });

    // Save updated cache to KV
    await env.hours.put(VATSIM_CACHE_KEY, JSON.stringify(vatsimCache));
  }

  // Apply cached data to all flagged records
  let enriched = 0;
  for (const record of flagged) {
    const cid = record.id.replace('audit_', '');
    const cached = vatsimCache[cid];
    if (cached) {
      record.lastSessionVatsim = cached.lastSession;
      record.lastCallsign = cached.lastCallsign;
      enriched++;
    }
  }

  // Save enriched store
  await saveStore(env, store);

  const remaining = needsLookup.length - toFetch.length;
  const stats = {
    totalFlagged: flagged.length,
    alreadyCached: flagged.length - needsLookup.length,
    attempted: toFetch.length,
    succeeded: toFetch.length > 0 ? (toFetch.length - rateLimited) : 0,
    failed: rateLimited,
    sampleFailures: failures.slice(0, 5),
    enrichedFromCache: enriched,
    remaining: remaining > 0 ? remaining : 0
  };
  logger.info('VATSIM enrichment complete', stats);
  return stats;
}

// ==================== Discord Notifications ====================

async function sendDiscordAuditAlert(env, store) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn('DISCORD_WEBHOOK_URL not configured — skipping notification');
    return;
  }

  const visitingFlagged = (store.visiting || []).filter(
    r => r.status === 'flagged'
  );
  const localNonDivision = (store.local || []).filter(
    r => r.status === 'not-division-member'
  );

  if (visitingFlagged.length === 0 && localNonDivision.length === 0) {
    logger.info('No flagged controllers — skipping Discord notification');
    return;
  }

  const embed = {
    title: '\u26a0\ufe0f VATPAC Controller Audit Alert',
    color: 0xff4444,
    timestamp: new Date().toISOString(),
    fields: []
  };

  if (visitingFlagged.length > 0) {
    const lines = visitingFlagged.map(r => {
      const hrs = r.hoursLogged ?? 0;
      const lastDate = r.lastSessionVatsim
        ? new Date(r.lastSessionVatsim).toISOString().split('T')[0]
        : 'N/A';
      const callsign = r.lastCallsign ? ` (${r.lastCallsign})` : '';
      return `\u2022 **${r.id.replace('audit_', '')}** — ${hrs}h / ${VISITING_HOURS_REQUIRED}h | Last: ${lastDate}${callsign}`;
    });
    // Discord field value max is 1024 chars — chunk if needed
    const chunk = lines.join('\n').slice(0, 1024);
    embed.fields.push({
      name: `Visiting Below Hours (${visitingFlagged.length})`,
      value: chunk || 'None',
      inline: false
    });
  }

  if (localNonDivision.length > 0) {
    const lines = localNonDivision.map(r => {
      return `\u2022 **${r.id.replace('audit_', '')}** — Division: ${r.division || 'unknown'}`;
    });
    const chunk = lines.join('\n').slice(0, 1024);
    embed.fields.push({
      name: `Local — Not Division Member (${localNonDivision.length})`,
      value: chunk || 'None',
      inline: false
    });
  }

  const body = {
    content: `<@&${DISCORD_ROLE_ID}> Daily audit completed with flagged controllers.`,
    embeds: [embed]
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.error('Discord webhook failed', null, { status: resp.status, body: text });
    } else {
      logger.info('Discord notification sent', {
        visitingFlagged: visitingFlagged.length,
        localNonDivision: localNonDivision.length
      });
    }
  } catch (err) {
    logger.error('Discord webhook request error', err);
  }
}

// ==================== Live VATSIM Rating Check ====================

async function checkLiveVatsimData(env) {
  logger.info('Fetching live VATSIM data for rating check');

  try {
    const response = await fetch(VATSIM_DATA_URL, {
      headers: { 'User-Agent': 'VATPAC-Audit-Worker' }
    });
    if (!response.ok) {
      logger.error('Failed to fetch VATSIM data', null, { status: response.status });
      return { ratingViolations: [], atisViolations: [], endorsementViolations: [] };
    }

    const vatsimData = await response.json();
    const controllers = vatsimData?.controllers || [];
    const atisConnections = vatsimData?.atis || [];

    // Get local controller CIDs from TMS
    const localCids = await getTMSList('local');
    const localCidSet = new Set(localCids.map(u => String(u.cid)));

    // Get endorsement map for all TMS users (reuses same cache)
    const endorsementMap = await getTMSEndorsementMap();
    const endorsementsByCid = await getTMSEndorsementsByCid();

    const ratingViolations = [];
    const atisViolations = [];
    const endorsementViolations = [];
    const now = Date.now();

    // Check each online controller on VATPAC positions
    for (const controller of controllers) {
      const callsign = String(controller.callsign || '').toUpperCase();
      const cid = String(controller.cid || '');
      const rating = controller.rating || 0;

      // Only check VATPAC positions
      if (!VATPAC_CALLSIGNS.has(callsign)) continue;

      // Rating check — local controllers only
      if (localCidSet.has(cid)) {
        const minRating = getMinRatingForPosition(callsign);
        const hasEnrSolo = hasValidEnrSoloEndorsement(endorsementsByCid, cid, callsign, now);
        const hasTmaSolo = hasValidTmaSoloEndorsement(endorsementsByCid, cid, callsign, now);
        if (rating < minRating && !hasEnrSolo && !hasTmaSolo) {
          ratingViolations.push({
            cid,
            callsign,
            rating,
            ratingShort: RATING_MAP[rating] || `R${rating}`,
            requiredRating: minRating,
            requiredRatingShort: RATING_MAP[minRating] || `R${minRating}`,
            logonTime: controller.logon_time
          });
        }
      }

      // Endorsement check — any TMS user on a Sydney Complex position
      if (SYD_COMPLEX_POSITIONS.has(callsign) && endorsementMap.has(cid)) {
        if (!endorsementMap.get(cid).has('sydTcu')) {
          endorsementViolations.push({
            cid,
            callsign,
            rating,
            ratingShort: RATING_MAP[rating] || `R${rating}`,
            missingEndorsement: 'Sydney Complex (sydTcu)',
            logonTime: controller.logon_time
          });
        }
      }
    }

    // Count ATIS connections per local controller CID
    const atisCountByCid = new Map();
    const atisByController = new Map();

    for (const atis of atisConnections) {
      const cid = String(atis.cid || '');
      const callsign = String(atis.callsign || '').toUpperCase();

      if (!callsign.endsWith('_ATIS')) continue;
      if (!localCidSet.has(cid)) continue;

      atisCountByCid.set(cid, (atisCountByCid.get(cid) || 0) + 1);
      if (!atisByController.has(cid)) atisByController.set(cid, []);
      atisByController.get(cid).push(callsign);
    }

    // Flag S1/S2 local controllers with more than 1 ATIS
    for (const [cid, count] of atisCountByCid) {
      if (count <= 1) continue;

      // Determine controller rating from controllers list or ATIS entries
      let controllerRating = 0;
      const onlineCtrl = controllers.find(c => String(c.cid) === cid);
      if (onlineCtrl) {
        controllerRating = onlineCtrl.rating || 0;
      } else {
        const atisEntry = atisConnections.find(a => String(a.cid) === cid);
        if (atisEntry) controllerRating = atisEntry.rating || 0;
      }

      // Only flag S1 (2) and S2 (3)
      // Exempt S2 controllers with a valid TMA solo on an approach position
      if (controllerRating === 3 && onlineCtrl) {
        const ctrlCallsign = String(onlineCtrl.callsign || '').toUpperCase();
        if (hasValidTmaSoloEndorsement(endorsementsByCid, cid, ctrlCallsign, now)) continue;
      }

      if (controllerRating === 2 || controllerRating === 3) {
        atisViolations.push({
          cid,
          rating: controllerRating,
          ratingShort: RATING_MAP[controllerRating] || `R${controllerRating}`,
          atisCount: count,
          atisCallsigns: atisByController.get(cid) || [],
          controlCallsign: onlineCtrl?.callsign || null
        });
      }
    }

    logger.info('Live VATSIM check complete', {
      controllersChecked: controllers.length,
      vatpacOnline: controllers.filter(c => VATPAC_CALLSIGNS.has(String(c.callsign || '').toUpperCase())).length,
      ratingViolations: ratingViolations.length,
      atisViolations: atisViolations.length,
      endorsementViolations: endorsementViolations.length
    });

    return { ratingViolations, atisViolations, endorsementViolations };

  } catch (err) {
    logger.error('Live VATSIM check failed', err);
    return { ratingViolations: [], atisViolations: [], endorsementViolations: [] };
  }
}

async function sendLiveViolationAlert(env, ratingViolations, atisViolations, endorsementViolations = []) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn('DISCORD_WEBHOOK_URL not configured — skipping live violation alert');
    return;
  }

  if (ratingViolations.length === 0 && atisViolations.length === 0 && endorsementViolations.length === 0) return;

  const embed = {
    title: '\u{1f6a8} Live Rating Violation Detected',
    color: 0xff0000,
    timestamp: new Date().toISOString(),
    fields: []
  };

  if (ratingViolations.length > 0) {
    const lines = ratingViolations.map(v =>
      `\u2022 **${v.cid}** on \`${v.callsign}\` \u2014 Rating: **${v.ratingShort}** (requires **${v.requiredRatingShort}**)`
    );
    embed.fields.push({
      name: `\u26a0\ufe0f Insufficient Rating (${ratingViolations.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false
    });
  }

  if (atisViolations.length > 0) {
    const lines = atisViolations.map(v => {
      const callsigns = v.atisCallsigns.map(c => `\`${c}\``).join(', ');
      const ctrl = v.controlCallsign ? ` | Controlling: \`${v.controlCallsign}\`` : '';
      return `\u2022 **${v.cid}** (${v.ratingShort}) \u2014 ${v.atisCount} ATIS: ${callsigns}${ctrl}`;
    });
    embed.fields.push({
      name: `\u{1f4e1} S1/S2 Multiple ATIS (${atisViolations.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false
    });
  }

  if (endorsementViolations.length > 0) {
    const lines = endorsementViolations.map(v =>
      `\u2022 **${v.cid}** on \`${v.callsign}\` \u2014 Missing: **${v.missingEndorsement}**`
    );
    embed.fields.push({
      name: `\u{1f6ab} Missing Endorsement (${endorsementViolations.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false
    });
  }

  const body = {
    content: `<@&${DISCORD_ROLE_ID}> Live controller violations detected!`,
    embeds: [embed]
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.error('Discord live violation webhook failed', null, { status: resp.status, body: text });
    } else {
      logger.info('Live violation Discord notification sent', {
        ratingViolations: ratingViolations.length,
        atisViolations: atisViolations.length
      });
    }
  } catch (err) {
    logger.error('Discord live violation webhook error', err);
  }
}

async function checkAndAlertLiveViolations(env) {
  const { ratingViolations, atisViolations, endorsementViolations } = await checkLiveVatsimData(env);

  if (ratingViolations.length === 0 && atisViolations.length === 0 && endorsementViolations.length === 0) {
    logger.info('No live violations detected');
    return { ratingViolations: 0, atisViolations: 0, endorsementViolations: 0, newAlerts: 0, alerted: false };
  }

  // Load already-alerted violations from KV to avoid spamming
  let alerted = {};
  try {
    alerted = await env.hours.get('live_violations_alerted', { type: 'json' }) || {};
  } catch { /* start fresh */ }

  const now = Date.now();

  // Filter out violations already alerted within the cooldown window
  const newRatingViolations = ratingViolations.filter(v => {
    const key = `rating_${v.cid}_${v.callsign}`;
    return !alerted[key] || (now - alerted[key] > LIVE_CHECK_ALERT_COOLDOWN_MS);
  });

  const newAtisViolations = atisViolations.filter(v => {
    const key = `atis_${v.cid}`;
    return !alerted[key] || (now - alerted[key] > LIVE_CHECK_ALERT_COOLDOWN_MS);
  });

  const newEndorsementViolations = endorsementViolations.filter(v => {
    const key = `endorse_${v.cid}_${v.callsign}`;
    return !alerted[key] || (now - alerted[key] > LIVE_CHECK_ALERT_COOLDOWN_MS);
  });

  if (newRatingViolations.length > 0 || newAtisViolations.length > 0 || newEndorsementViolations.length > 0) {
    await sendLiveViolationAlert(env, newRatingViolations, newAtisViolations, newEndorsementViolations);

    // Mark as alerted
    for (const v of newRatingViolations) alerted[`rating_${v.cid}_${v.callsign}`] = now;
    for (const v of newAtisViolations) alerted[`atis_${v.cid}`] = now;
    for (const v of newEndorsementViolations) alerted[`endorse_${v.cid}_${v.callsign}`] = now;

    // Prune entries older than 24 hours
    for (const [key, ts] of Object.entries(alerted)) {
      if (now - ts > 24 * 60 * 60 * 1000) delete alerted[key];
    }

    await env.hours.put('live_violations_alerted', JSON.stringify(alerted));
  }

  return {
    ratingViolations: ratingViolations.length,
    atisViolations: atisViolations.length,
    endorsementViolations: endorsementViolations.length,
    newAlerts: newRatingViolations.length + newAtisViolations.length + newEndorsementViolations.length,
    alerted: newRatingViolations.length > 0 || newAtisViolations.length > 0 || newEndorsementViolations.length > 0
  };
}

// ==================== Worker Entry Points ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS') {
        return handleCORS(env, request);
      }

      // Handle /test-vatsim/:cid - test single VATSIM API call from Worker
      if (url.pathname.startsWith('/test-vatsim/')) {
        const cid = url.pathname.split('/')[2];
        try {
          const apiUrl = `https://api.vatsim.net/v2/members/${cid}/atc?limit=1`;
          const r = await fetch(apiUrl, { headers: { 'User-Agent': 'VATPAC-Audit-Worker' } });
          const body = await r.text();
          return jsonResponse({
            status: r.status,
            statusText: r.statusText,
            headers: Object.fromEntries(r.headers.entries()),
            body: body.substring(0, 500)
          }, 200, env, request);
        } catch (e) {
          return jsonResponse({ error: e.message }, 500, env, request);
        }
      }

      // Handle /live-check - runs live VATSIM rating + ATIS check
      if ((url.pathname === '/live-check' || url.pathname === '/api/live-check') && request.method === 'POST') {
        try {
          const result = await checkAndAlertLiveViolations(env);
          return jsonResponse({ success: true, ...result }, 200, env, request);
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500, env, request);
        }
      }

      // Handle /enrich - runs VATSIM enrichment only
      if (url.pathname === '/enrich' && request.method === 'POST') {
        try {
          const stats = await enrichFlaggedWithVatsimLastSession(env);
          return jsonResponse({ success: true, enrichment: stats }, 200, env, request);
        } catch (e) {
          return jsonResponse({ success: false, error: e.message, stack: e.stack }, 500, env, request);
        }
      }

      // Handle /trigger and /api/trigger - runs full audit in single invocation
      if ((url.pathname === '/trigger' || url.pathname === '/api/trigger') && request.method === 'POST') {
        const result = await runDailyAudit(env);
        result.message = 'All audits complete.';
        
        return jsonResponse({
          success: true,
          ...result
        }, 200, env, request);
      }

      // Handle /reset - clears all data and resets state
      if (url.pathname === '/reset' && request.method === 'POST') {
        const store = await loadStore(env);
        store.initFlags = { visitingInit: false, localInit: false };
        store.batchProgress = { visitingOffset: 0, localOffset: 0 };
        store.visiting = [];
        store.local = [];
        store.lastRun = null;
        await saveStore(env, store);
        
        logger.info('Worker reset via /reset endpoint');
        
        return jsonResponse({
          success: true,
          message: 'All data cleared. Next trigger will reinitialize.'
        }, 200, env, request);
      }

      if (url.pathname.startsWith('/api/')) {
        return await handleAPI(request, env);
      }

      if (url.pathname === '/') {
        return jsonResponse({
          status: 'ok',
          version: '4.0.0',
          requirements: {
            visiting: `${VISITING_HOURS_REQUIRED} hours per ${MONTHS_LOOKBACK} months`,
            local: `Once per ${LOCAL_MONTHS_REQUIRED} months`
          }
        }, 200, env, request);
      }

      return jsonResponse({ error: 'Not Found' }, 404, env, request);

    } catch (error) {
      logger.error('Worker unhandled error', error, { path: url.pathname });
      return jsonResponse({ error: 'Internal Server Error', message: error?.message }, 500, env, request);
    }
  },

  async scheduled(event, env, ctx) {
    logger.info('Scheduled task triggered', { scheduledTime: event.scheduledTime });
    try {
      // Run live rating/ATIS check on every scheduled tick
      const liveResult = await checkAndAlertLiveViolations(env);
      logger.info('Live violation check complete', liveResult);

      // Run full daily audit only once per day (e.g., on the first cron of the day)
      const store = await loadStore(env);
      const lastRun = store.lastRun ? new Date(store.lastRun) : null;
      const hoursSinceLastAudit = lastRun ? (Date.now() - lastRun.getTime()) / 1000 / 3600 : Infinity;

      if (hoursSinceLastAudit >= 20) {
        await runDailyAudit(env);
        logger.info('Scheduled daily audit complete');
      } else {
        logger.info('Skipping daily audit — last run was recent', { hoursSinceLastAudit: Math.round(hoursSinceLastAudit) });
      }
    } catch (error) {
      logger.error('Scheduled task failed', error);
      throw error;
    }
  }
};
