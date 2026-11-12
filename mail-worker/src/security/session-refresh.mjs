// Authorization still reads and validates the current token list on every
// request. Only the optional daily session-TTL renewal is coalesced here.
const MAX_USERS = 256;
const RETRY_MS = 60 * 1000;
const TOKEN_TTL = 30 * 24 * 60 * 60;

export function createSessionRefresher({ now = Date.now, onError = () => console.warn('Optional session renewal deferred') } = {}) {
	const environments = new WeakMap();
	return async function refreshSession(c, authInfo, updateUserInfo) {
		const timestamp = now();
		const day = new Date(timestamp).toISOString().slice(0, 10);
		const previous = new Date(authInfo.refreshTime);
		if (Number.isFinite(previous.getTime()) && previous.toISOString().slice(0, 10) === day) return;

		let users = environments.get(c.env);
		if (!users) {
			users = new Map();
			environments.set(c.env, users);
		}
		for (const [id, record] of users) {
			if (!record.pending && (record.day !== day || record.retryAt <= timestamp)) users.delete(id);
		}
		const userId = authInfo.user.userId;
		const existing = users.get(userId);
		if (existing?.pending) return existing.pending;
		if (existing?.day === day && existing.retryAt > timestamp) return;

		const record = { day, retryAt: timestamp + RETRY_MS };
		const task = (async () => {
			try {
				await updateUserInfo(c, userId);
				const renewed = { ...authInfo, refreshTime: new Date(timestamp).toISOString() };
				await c.env.kv.put(`auth-uid:${userId}`, JSON.stringify(renewed), { expirationTtl: TOKEN_TTL });
				record.retryAt = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;
			} catch {
				// Existing valid sessions remain usable when only the TTL write fails.
				record.retryAt = now() + RETRY_MS;
				onError();
			}
		})();
		record.pending = task;
		users.set(userId, record);
		while (users.size > MAX_USERS) users.delete(users.keys().next().value);
		try {
			await task;
		} finally {
			delete record.pending;
		}
	};
}

export const refreshSession = createSessionRefresher();
