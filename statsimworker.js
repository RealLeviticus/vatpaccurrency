// Cloudflare Worker: StatSim position sessions fetcher
// Fetches StatSim position session data for all PAC callsigns in worker-complete.js

const STAT_SIM_BASE = "https://api.statsim.net/api/Atcsessions/Callsign";

// Cloudflare Workers subrequest limits:
// - Free tier: 50 subrequests per invocation
// - Paid (Workers Paid/Bundled): 1000 subrequests
// We'll use a conservative limit and save progress to KV to resume
// Cron trigger handles auto-resumption - configure in wrangler.toml:
//   [triggers]
//   crons = ["*/3 * * * *"]  # Every 3 minutes - will resume if paused
const MAX_SUBREQUESTS_PER_RUN = 45; // Leave buffer for KV operations
const PROGRESS_KEY = 'statsim:progress';
const LAST_COMPLETE_KEY = 'statsim:lastComplete'; // Track when last successful run completed

// ==================== Observability Logger ====================
const logger = {
	info: (message, data = {}) => {
		console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), message, ...data }));
	},
	warn: (message, data = {}) => {
		console.warn(JSON.stringify({ level: 'WARN', timestamp: new Date().toISOString(), message, ...data }));
	},
	error: (message, error = null, data = {}) => {
		console.error(JSON.stringify({
			level: 'ERROR',
			timestamp: new Date().toISOString(),
			message,
			error: error?.message || error || null,
			stack: error?.stack || null,
			...data
		}));
	},
	metric: (name, value, tags = {}) => {
		console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value, ...tags }));
	}
};

// VATPAC callsigns - auto-synced from vatSys datasets
// To update, run: node scripts/sync-positions.js
import { PAC_CALLSIGNS as SYNCED_CALLSIGNS } from './positions.js';

// Fallback hardcoded callsigns in case positions.js import fails
const FALLBACK_CALLSIGNS = [
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
	'ML-IND_FSS', 'BN-TSN_FSS', 'ML-ASP_CTR', 'ML-BLA_CTR', 'ML-GUN_CTR', 'ML-HUO_CTR',
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
];

// Use synced callsigns if available, otherwise fall back to hardcoded
const PAC_CALLSIGNS = (SYNCED_CALLSIGNS && SYNCED_CALLSIGNS.length > 0) ? SYNCED_CALLSIGNS : FALLBACK_CALLSIGNS;

// Format date as ISO 8601 UTC for StatSim API
function formatStatSimDate(date) {
	return date.toISOString();
}

// Build range: from = today minus one year at 00:00Z, to = today at 22:00Z
function buildRange() {
	const today = new Date();

	const from = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
	const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 22, 0, 0, 0));

	return { from, to };
}

async function fetchCallsignSessions(callsign, range, abortSignal, sleepMs = 0, userAgent = 'Mozilla/5.0 (compatible; StatSimFetcher/1.0)', maxRetries = 2, retryDelayMs = 300, apiKey = null) {
	const url = new URL(STAT_SIM_BASE);
	url.searchParams.set('callsign', callsign);
	url.searchParams.set('from', formatStatSimDate(range.from));
	url.searchParams.set('to', formatStatSimDate(range.to));

	let lastError = null;
	let lastStatus = null;
	let lastHtmlSnippet = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const headers = {
				Accept: 'application/json',
				'User-Agent': userAgent,
				Referer: 'https://statsim.net/'
			};
			if (apiKey) {
				headers['X-API-Key'] = apiKey;
			}
			const res = await fetch(url.toString(), {
				signal: abortSignal,
				headers
			});

			const text = await res.text();

			// Treat missing callsigns as empty instead of failing the batch
			if (res.status === 404) {
				if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
				return [];
			}

			if (!res.ok) {
				lastError = `StatSim ${callsign} HTTP ${res.status}`;
				lastStatus = res.status;
				lastHtmlSnippet = text.slice(0, 200);
				throw new Error(lastError);
			}

			// If StatSim returns HTML (likely an error page), surface it clearly
			const contentType = res.headers.get('content-type') || '';
			if (/text\/html/i.test(contentType)) {
				lastError = `StatSim ${callsign} returned HTML (possible error/blocked request)`;
				lastStatus = res.status;
				lastHtmlSnippet = text.slice(0, 200);
				throw new Error(lastError);
			}

			let data;
			try {
				data = JSON.parse(text);
			} catch (parseErr) {
				lastError = `StatSim ${callsign} parse failed: ${parseErr?.message || 'Invalid JSON'}`;
				lastStatus = res.status;
				lastHtmlSnippet = text.slice(0, 200);
				throw new Error(lastError);
			}

			if (sleepMs > 0) {
				await new Promise(r => setTimeout(r, sleepMs));
			}

			return data;
		} catch (err) {
			const isRateLimited = lastStatus === 429;
			const retryable = isRateLimited || (lastStatus >= 500 && lastStatus < 600) || lastStatus === null;
			if (!retryable || attempt === maxRetries) {
				// Return error info as a thrown object
				const errorObj = {
					message: isRateLimited
						? `StatSim ${callsign} rate limited (429) after ${maxRetries + 1} attempts`
						: (lastError || err?.message || 'Unknown error'),
					status: lastStatus,
					htmlSnippet: lastHtmlSnippet,
					rateLimited: isRateLimited
				};
				throw errorObj;
			}
			// Use longer backoff for rate limiting
			const baseDelay = isRateLimited ? Math.max(retryDelayMs, 1000) : retryDelayMs;
			const backoff = baseDelay * Math.pow(2, attempt);
			await new Promise(r => setTimeout(r, backoff));
		}
	}

	// Should not reach here, but just in case
	throw { message: `StatSim ${callsign} failed after retries`, status: lastStatus, htmlSnippet: lastHtmlSnippet, rateLimited: false };
}

// Load progress from KV to resume interrupted runs
async function loadProgress(env) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.get !== 'function') return null;
	try {
		const stored = await kv.get(PROGRESS_KEY, { type: 'json' });
		return stored;
	} catch (err) {
		logger.error('Failed to load progress from KV', err);
		return null;
	}
}

// Save progress to KV for resumption
async function saveProgress(env, progress) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.put !== 'function') return false;
	try {
		await kv.put(PROGRESS_KEY, JSON.stringify(progress));
		return true;
	} catch (err) {
		logger.error('Failed to save progress to KV', err);
		return false;
	}
}

// Clear progress after successful completion
async function clearProgress(env) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.delete !== 'function') return false;
	try {
		await kv.delete(PROGRESS_KEY);
		return true;
	} catch (err) {
		logger.warn('Failed to clear progress from KV', err);
		return false;
	}
}

// Check if we already completed a run today (UTC)
async function wasCompletedToday(env) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.get !== 'function') return false;
	try {
		const lastComplete = await kv.get(LAST_COMPLETE_KEY, { type: 'json' });
		if (!lastComplete?.completedAt) return false;
		
		const lastDate = new Date(lastComplete.completedAt);
		const today = new Date();
		
		// Compare UTC dates
		return lastDate.getUTCFullYear() === today.getUTCFullYear() &&
			   lastDate.getUTCMonth() === today.getUTCMonth() &&
			   lastDate.getUTCDate() === today.getUTCDate();
	} catch (err) {
		logger.warn('Failed to check last completion', err);
		return false;
	}
}

// Mark run as completed today
async function markCompleted(env, stats = {}) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.put !== 'function') return false;
	try {
		await kv.put(LAST_COMPLETE_KEY, JSON.stringify({
			completedAt: new Date().toISOString(),
			...stats
		}));
		return true;
	} catch (err) {
		logger.warn('Failed to mark completion', err);
		return false;
	}
}

// Clear the completion marker (for /reset)
async function clearCompletion(env) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.delete !== 'function') return false;
	try {
		await kv.delete(LAST_COMPLETE_KEY);
		return true;
	} catch (err) {
		logger.warn('Failed to clear completion marker', err);
		return false;
	}
}
// Cron-based resumption: configure frequent crons in wrangler.toml
// The scheduled() handler will automatically resume from pausedAtOffset
// Example: crons = ["*/3 * * * *"] runs every 3 minutes
async function gatherAllSessions(offset = 0, limit = 40, sleepMs = 0, userAgent = 'Mozilla/5.0 (compatible; StatSimFetcher/1.0)', maxRetries = 2, retryDelayMs = 300, persistEach = false, env = null, apiKey = null) {
	const range = buildRange();
	const controller = new AbortController();

	logger.info('Starting gatherAllSessions', { offset, limit, totalCallsigns: PAC_CALLSIGNS.length });

	// Track subrequests to avoid hitting Cloudflare limits
	let subrequestCount = 0;
	let paused = false;
	let pausedAtOffset = offset;

	// Load any existing progress to merge with
	let existingData = [];
	let existingErrors = [];
	let processedCallsigns = new Set(); // Track which callsigns we've already processed
	
	if (env) {
		const progress = await loadProgress(env);
		if (progress?.data) {
			existingData = progress.data;
			existingErrors = progress.errors || [];
			// Build set of already-processed callsigns to avoid duplicates
			for (const entry of existingData) {
				if (entry.callsign) processedCallsigns.add(entry.callsign);
			}
			for (const entry of existingErrors) {
				if (entry.callsign) processedCallsigns.add(entry.callsign);
			}
			logger.info('Loaded existing progress', { 
				existingDataCount: existingData.length, 
				existingErrorCount: existingErrors.length,
				processedCallsignsCount: processedCallsigns.size
			});
		}
		subrequestCount++; // Count the KV read
	}

	const slice = PAC_CALLSIGNS.slice(offset, offset + limit);

	if (slice.length === 0) {
		logger.info('No callsigns to process - offset beyond list');
		return {
			range: {
				from: formatStatSimDate(range.from),
				to: formatStatSimDate(range.to)
			},
			totalCallsigns: PAC_CALLSIGNS.length,
			offset,
			limit,
			successes: 0,
			failures: 0,
			data: existingData,
			errors: existingErrors,
			nextOffset: null,
			message: 'Offset beyond callsign list',
			paused: false
		};
	}

	const results = [];
	for (let i = 0; i < slice.length; i++) {
		const callsign = slice[i];

		// Skip callsigns we've already processed (prevents duplicates on resume)
		if (processedCallsigns.has(callsign)) {
			logger.info('Skipping already-processed callsign', { callsign, offset: offset + i });
			continue;
		}

		// Check if we're approaching the subrequest limit
		// Each fetchCallsignSessions does 1 fetch + potentially maxRetries more
		const estimatedSubrequests = subrequestCount + 1 + maxRetries;
		if (estimatedSubrequests >= MAX_SUBREQUESTS_PER_RUN) {
			logger.warn('Approaching subrequest limit - pausing to save progress', {
				subrequestCount,
				callsignsProcessed: results.length,
				callsignsRemaining: slice.length - i,
				pausedAtCallsign: callsign
			});
			paused = true;
			pausedAtOffset = offset + i;
			break;
		}

		try {
			const data = await fetchCallsignSessions(callsign, range, controller.signal, sleepMs, userAgent, maxRetries, retryDelayMs, apiKey);
			subrequestCount++; // At minimum 1 subrequest per callsign
			const entry = { callsign, ok: true, data };
			results.push(entry);
			processedCallsigns.add(callsign); // Mark as processed
			logger.metric('callsign_fetch_success', 1, { callsign, sessionCount: data?.length || 0 });
		} catch (err) {
			subrequestCount += (err?.retryCount || 0) + 1; // Count retries
			const entry = {
				callsign,
				ok: false,
				error: err?.message || 'Unknown error',
				htmlSnippet: err?.htmlSnippet || null,
				rateLimited: err?.rateLimited || false,
				status: err?.status || null
			};
			results.push(entry);
			processedCallsigns.add(callsign); // Mark as processed even on error
			logger.error('Callsign fetch failed', null, { callsign, status: err?.status, rateLimited: err?.rateLimited });
			logger.metric('callsign_fetch_failure', 1, { callsign, status: err?.status });
		}

		// Save progress after each callsign (incremental save)
		if (persistEach && env && (results.length % 5 === 0 || paused)) {
			const allData = [...existingData, ...results.filter(r => r.ok)];
			const allErrors = [...existingErrors, ...results.filter(r => !r.ok)];
			const progressPayload = {
				range: {
					from: formatStatSimDate(range.from),
					to: formatStatSimDate(range.to)
				},
				totalCallsigns: PAC_CALLSIGNS.length,
				offset,
				limit,
				processed: offset + results.length,
				successes: allData.length,
				failures: allErrors.length,
				data: allData,
				errors: allErrors,
				nextOffset: paused ? pausedAtOffset : (offset + slice.length < PAC_CALLSIGNS.length ? offset + slice.length : null),
				inProgress: true,
				paused,
				pausedAtOffset: paused ? pausedAtOffset : null,
				subrequestCount
			};
			await saveToKV(env, 'statsim:sessions', progressPayload);
			await saveProgress(env, progressPayload);
			subrequestCount += 2; // Count KV writes
		}
	}

	// Merge results with existing data
	const allSuccesses = [...existingData, ...results.filter(r => r.ok)];
	const allFailures = [...existingErrors, ...results.filter(r => !r.ok)];

	logger.info('gatherAllSessions batch complete', {
		processedThisRun: results.length,
		totalSuccesses: allSuccesses.length,
		totalFailures: allFailures.length,
		subrequestCount,
		paused,
		pausedAtOffset: paused ? pausedAtOffset : null
	});

	logger.metric('batch_complete', 1, {
		processed: results.length,
		successes: results.filter(r => r.ok).length,
		failures: results.filter(r => !r.ok).length,
		subrequests: subrequestCount,
		paused
	});

	return {
		range: {
			from: formatStatSimDate(range.from),
			to: formatStatSimDate(range.to)
		},
		totalCallsigns: PAC_CALLSIGNS.length,
		offset,
		limit,
		successes: allSuccesses.length,
		failures: allFailures.length,
		data: allSuccesses,
		errors: allFailures,
		nextOffset: paused ? pausedAtOffset : (offset + slice.length < PAC_CALLSIGNS.length ? offset + slice.length : null),
		paused,
		pausedAtOffset: paused ? pausedAtOffset : null,
		subrequestCount,
		processedThisRun: results.length,
		totalProcessed: processedCallsigns.size // Total unique callsigns processed
	};
}

// Persist the aggregated payload into a KV binding if available
async function saveToKV(env, key, payload) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.put !== 'function') return false;
	const value = JSON.stringify({ savedAt: new Date().toISOString(), key, payload });
	try {
		await kv.put(key, value);
		return true;
	} catch (_err) {
		return false;
	}
}

async function saveCallsignResult(env, callsign, range, result) {
	const kv = env?.sessions || env?.statsim || env?.STAT_SIM || env?.statSim || env?.STATSim || env?.STAT_SIM_KV || env?.STATSIM_KV;
	if (!kv || typeof kv.put !== 'function') return false;
	const key = `statsim:callsign:${callsign}:from:${formatStatSimDate(range.from)}:to:${formatStatSimDate(range.to)}`;
	const value = JSON.stringify({ savedAt: new Date().toISOString(), callsign, range: { from: formatStatSimDate(range.from), to: formatStatSimDate(range.to) }, result });
	try {
		await kv.put(key, value);
		return true;
	} catch (_err) {
		return false;
	}
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json'
		}
	});
}

export default {
	async fetch(request, env, ctx) {
		try {
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type'
					}
				});
			}

			const url = new URL(request.url);

			// Route handling
			const validPaths = ['/', '/trigger', '/resume', '/status', '/reset'];
			if (!validPaths.includes(url.pathname)) {
				return jsonResponse({ error: 'Not Found', validPaths }, 404);
			}

			// GET /status - Check current progress without running
			if (url.pathname === '/status') {
				const progress = await loadProgress(env);
				const alreadyCompletedToday = await wasCompletedToday(env);
				
				// Get last completion info
				const kv = env?.sessions || env?.statsim;
				let lastComplete = null;
				if (kv) {
					try {
						lastComplete = await kv.get(LAST_COMPLETE_KEY, { type: 'json' });
					} catch (_) {}
				}
				
				if (!progress) {
					return jsonResponse({
						status: alreadyCompletedToday ? 'completed-today' : 'idle',
						message: alreadyCompletedToday 
							? 'Already completed today. Use /reset to force a new run.'
							: 'No progress saved. Use /trigger to start a new run.',
						totalCallsigns: PAC_CALLSIGNS.length,
						lastComplete
					}, 200);
				}
				return jsonResponse({
					status: progress.paused ? 'paused' : (progress.inProgress ? 'in-progress' : 'complete'),
					processed: progress.processed || 0,
					totalCallsigns: PAC_CALLSIGNS.length,
					successes: progress.successes || 0,
					failures: progress.failures || 0,
					nextOffset: progress.nextOffset,
					pausedAtOffset: progress.pausedAtOffset,
					range: progress.range,
					message: progress.paused
						? `Paused at offset ${progress.pausedAtOffset}. Use /resume to continue.`
						: 'Run in progress or complete',
					lastComplete,
					alreadyCompletedToday
				}, 200);
			}

			// GET /reset - Clear all progress and start fresh
			if (url.pathname === '/reset') {
				await clearProgress(env);
				await clearCompletion(env);
				logger.info('Progress and completion marker reset by user');
				return jsonResponse({
					status: 'reset',
					message: 'Progress and completion marker cleared. Use /trigger to start a fresh run.'
				}, 200);
			}

			// GET /resume - Resume from where we left off (auto-continues until complete)
			if (url.pathname === '/resume') {
				const progress = await loadProgress(env);
				if (!progress || !progress.paused) {
					return jsonResponse({
						status: 'nothing-to-resume',
						message: 'No paused run to resume. Use /trigger to start a new run.',
						currentProgress: progress
					}, 200);
				}

				logger.info('Resuming from paused state', { pausedAtOffset: progress.pausedAtOffset });

				const sleepMs = 300;
				const maxRetries = 3;
				const retryDelayMs = 1000;

				const payload = await gatherAllSessions(
					progress.pausedAtOffset,
					PAC_CALLSIGNS.length - progress.pausedAtOffset,
					sleepMs,
					'Mozilla/5.0 (compatible; StatSimFetcher/1.0; Resume)',
					maxRetries,
					retryDelayMs,
					true,
					env,
					env.STATSIM_API_KEY
				);

				const kvKey = 'statsim:sessions';
				payload.saved = await saveToKV(env, kvKey, payload);
				payload.kvKey = kvKey;
				payload.resumedFrom = progress.pausedAtOffset;

				// If we finished all callsigns, clear progress (only if save succeeded)
				if (!payload.saved) {
					payload.status = 'save_failed';
					payload.message = 'KV save failed — completion NOT marked. Retry or check KV limits.';
					logger.error('KV save failed on resume — will NOT mark as completed', { successes: payload.successes, failures: payload.failures });
				} else if (!payload.paused && payload.nextOffset === null) {
					await clearProgress(env);
					await markCompleted(env, { successes: payload.successes, failures: payload.failures });
					payload.status = 'complete';
					logger.info('All callsigns processed - run complete', { successes: payload.successes, failures: payload.failures });
				} else {
					payload.status = 'paused';
					payload.message = `Paused at offset ${payload.pausedAtOffset}. Next cron will auto-resume, or call /resume manually.`;
					logger.info('Run paused - next cron will resume', { pausedAtOffset: payload.pausedAtOffset });
				}

				return jsonResponse(payload, 200);
			}

			// GET /trigger - Start fresh run (clears any existing progress, auto-continues until complete)
			if (url.pathname === '/trigger') {
				// Check if already completed today
				const forceRun = url.searchParams.get('force') === 'true';
				if (!forceRun && await wasCompletedToday(env)) {
					logger.info('Skipping trigger - already completed today');
					return jsonResponse({
						status: 'skipped',
						message: 'Already completed today. Use /trigger?force=true to force a new run, or /reset to clear.',
						alreadyCompletedToday: true
					}, 200);
				}
				
				// Clear any existing progress to start fresh
				await clearProgress(env);
				logger.info('Starting fresh trigger run');

				const sleepMs = 300;
				const maxRetries = 3;
				const retryDelayMs = 1000;

				const payload = await gatherAllSessions(
					0,
					PAC_CALLSIGNS.length,
					sleepMs,
					'Mozilla/5.0 (compatible; StatSimFetcher/1.0; ManualTrigger)',
					maxRetries,
					retryDelayMs,
					true,
					env,
					env.STATSIM_API_KEY
				);

				const kvKey = 'statsim:sessions';
				payload.saved = await saveToKV(env, kvKey, payload);
				payload.kvKey = kvKey;

				// If we finished all callsigns, clear progress (only if save succeeded)
				if (!payload.saved) {
					payload.status = 'save_failed';
					payload.message = 'KV save failed — completion NOT marked. Retry or check KV limits.';
					logger.error('KV save failed on trigger — will NOT mark as completed', { successes: payload.successes, failures: payload.failures });
				} else if (!payload.paused && payload.nextOffset === null) {
					await clearProgress(env);
					await markCompleted(env, { successes: payload.successes, failures: payload.failures });
					payload.status = 'complete';
					logger.info('All callsigns processed in single run', { successes: payload.successes, failures: payload.failures });
				} else {
					payload.status = 'paused';
					payload.message = `Paused at offset ${payload.pausedAtOffset} due to subrequest limit. Next cron will auto-resume, or call /resume manually.`;
					logger.warn('Run paused due to subrequest limit', { pausedAtOffset: payload.pausedAtOffset, subrequestCount: payload.subrequestCount });
				}

				return jsonResponse(payload, 200);
			}

			const offsetParam = url.searchParams.get('offset');
			const limitParam = url.searchParams.get('limit');
			const fetchAll = offsetParam === null && limitParam === null; // no offset/limit provided -> grab entire list
			const offset = offsetParam === null ? 0 : Number(offsetParam);
			const limit = fetchAll ? PAC_CALLSIGNS.length : Math.min(Number(limitParam || 40), 45); // cap when client passes limit
			const sleepMs = Math.max(0, Number(url.searchParams.get('sleep') || 250));
			const userAgent = url.searchParams.get('ua') || 'Mozilla/5.0 (compatible; StatSimFetcher/1.0)';
			const maxRetries = Math.max(0, Number(url.searchParams.get('retries') || 2));
			const retryDelayMs = Math.max(0, Number(url.searchParams.get('retryDelay') || 300));
			const persist = url.searchParams.get('persist') === 'true';
			const persistEach = url.searchParams.get('persistEach') === 'true';

			const payload = await gatherAllSessions(offset, limit, sleepMs, userAgent, maxRetries, retryDelayMs, persistEach, env, env.STATSIM_API_KEY);

			if (persist) {
				const kvKey = `statsim:offset:${offset}:limit:${limit}`;
				payload.saved = await saveToKV(env, kvKey, payload);
				payload.kvKey = kvKey;
			}

			return jsonResponse(payload, 200);
		} catch (err) {
			return jsonResponse({ error: err?.message || 'Internal Error' }, 500);
		}
	},

	// Cron Trigger: runs automatically on schedule, resumes from progress or starts fresh
	// Will auto-continue until all callsigns are processed
	async scheduled(event, env, ctx) {
		logger.info('Scheduled cron triggered', { scheduledTime: event.scheduledTime });

		try {
			// Check if there's a paused run or partial progress that needs resuming
			const progress = await loadProgress(env);
			
			// Determine if we need to resume from partial progress
			const hasPartialProgress = progress?.data?.length > 0 || progress?.processed > 0;
			const isPaused = progress?.paused && progress.pausedAtOffset !== null;
			
			// If no partial progress and not paused, check if we already completed today
			if (!hasPartialProgress && !isPaused) {
				const alreadyDone = await wasCompletedToday(env);
				if (alreadyDone) {
					logger.info('Skipping scheduled run - already completed today');
					return; // Exit early to save usage
				}
			}
			
			const sleepMs = 300;
			const maxRetries = 3;
			const retryDelayMs = 1000;

			// Determine start offset: use pausedAtOffset, or calculate from processed count, or 0
			let startOffset = 0;
			
			if (isPaused) {
				startOffset = progress.pausedAtOffset;
				logger.info('Resuming from paused state', { pausedAtOffset: startOffset });
			} else if (hasPartialProgress) {
				// Use processed count or data length as fallback
				const processedCount = progress.processed || (progress.data?.length || 0) + (progress.errors?.length || 0);
				startOffset = Math.min(processedCount, PAC_CALLSIGNS.length);
				logger.info('Resuming from partial progress', { startOffset, processedCount });
			} else {
				logger.info('Starting fresh run');
			}

			const payload = await gatherAllSessions(
				startOffset,
				PAC_CALLSIGNS.length - startOffset,
				sleepMs,
				'Mozilla/5.0 (compatible; StatSimFetcher/1.0; Scheduled)',
				maxRetries,
				retryDelayMs,
				true,
				env,
				env.STATSIM_API_KEY
			);

			const kvKey = 'statsim:sessions';
				const saved = await saveToKV(env, kvKey, payload);

				if (!saved) {
					logger.error('Failed to save statsim:sessions to KV — will NOT mark as completed so next cron retries', {
						successes: payload.successes,
						failures: payload.failures
					});
					// Do NOT markCompleted — next cron will retry
				} else if (!payload.paused && payload.nextOffset === null) {
				await clearProgress(env);
				await markCompleted(env, { successes: payload.successes, failures: payload.failures, totalProcessed: payload.totalProcessed });
				logger.info('Scheduled run complete - all callsigns processed', {
					successes: payload.successes,
					failures: payload.failures,
					totalProcessed: payload.totalProcessed,
					subrequestCount: payload.subrequestCount
				});
				logger.metric('scheduled_run_complete', 1, { successes: payload.successes, failures: payload.failures });
			} else {
				// Paused - next cron invocation will automatically resume from pausedAtOffset
				logger.info('Scheduled run paused - next cron will resume', {
					pausedAtOffset: payload.pausedAtOffset,
					processedSoFar: payload.successes + payload.failures,
					subrequestCount: payload.subrequestCount
				});
				logger.metric('scheduled_run_paused', 1, { pausedAtOffset: payload.pausedAtOffset });
			}

		} catch (err) {
			logger.error('Scheduled run failed with exception', err, { scheduledTime: event.scheduledTime });
			logger.metric('scheduled_run_error', 1, { error: err?.message });
			throw err; // Re-throw so Cloudflare logs it
		}
	}
};
