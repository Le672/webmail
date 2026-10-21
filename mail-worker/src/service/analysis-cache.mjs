// Statistics are derived from D1. Cache them at the edge without spending the
// account's KV write quota or persisting an unbounded set of visitor time zones.
const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 32;

export function normalizeTimeZone(value) {
	try {
		return new Intl.DateTimeFormat('en', { timeZone: typeof value === 'string' ? value : 'UTC' }).resolvedOptions().timeZone;
	} catch {
		return 'UTC';
	}
}

export function createAnalysisCache({ now = Date.now, edgeCache = () => globalThis.caches?.default } = {}) {
	const environments = new WeakMap();

	return async function cachedAnalysis(c, params, query) {
		const timeZone = normalizeTimeZone(params?.timeZone);
		const normalized = { ...params, timeZone };
		if (c.env.analysis_cache !== true && c.env.analysis_cache !== 'true') {
			return query(normalized);
		}

		let entries = environments.get(c.env);
		if (!entries) {
			entries = new Map();
			environments.set(c.env, entries);
		}
		for (const [key, value] of entries) {
			if (value.expiresAt <= now()) entries.delete(key);
		}
		const existing = entries.get(timeZone);
		if (existing) return existing.pending || existing.data;

		const url = new URL(`/__internal/analysis-cache/v2/${encodeURIComponent(timeZone)}`, c.req?.url || 'https://mail.yukino.bond');
		const cacheKey = new Request(url.href);
		const entry = { expiresAt: now() + TTL_MS };
		const task = (async () => {
			let edge;
			try {
				edge = edgeCache();
				const hit = await edge?.match(cacheKey);
				if (hit) {
					const record = await hit.json();
					if (record.expiresAt > now() && record.data) {
						entry.expiresAt = record.expiresAt;
						return record.data;
					}
				}
			} catch { /* Optional cache failures must not prevent statistics. */ }

			const data = await query(normalized);
			entry.expiresAt = now() + TTL_MS;
			try {
				await edge?.put(cacheKey, new Response(JSON.stringify({ data, expiresAt: entry.expiresAt }), {
					headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL_MS / 1000}` }
				}));
			} catch { /* Derived statistics are still available from D1. */ }
			return data;
		})();
		entry.pending = task;
		entries.set(timeZone, entry);
		while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
		try {
			const data = await task;
			entry.data = data;
			delete entry.pending;
			return data;
		} catch (error) {
			if (entries.get(timeZone) === entry) entries.delete(timeZone);
			throw error;
		}
	};
}

export const cachedAnalysis = createAnalysisCache();
