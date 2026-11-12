import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRefresher } from '../src/security/session-refresh.mjs';
import { loadService } from './service-harness.mjs';

function info() { return { user: { userId: 42, email: 'user@yukino.bond' }, tokens: ['valid'], refreshTime: '2026-10-19T00:00:00Z' }; }

test('coalesces optional renewal even if concurrent KV reads keep returning the previous day', async () => {
	const now = () => Date.parse('2026-10-21T00:01:00Z');
	const renew = createSessionRefresher({ now });
	let writes = 0;
	let updates = 0;
	let written;
	const c = { env: { kv: { async put(key, value, options) { writes++; written = { key, data: JSON.parse(value), options }; } } } };
	const update = async () => { updates++; };
	await Promise.all(Array.from({ length: 20 }, () => renew(c, info(), update)));
	await renew(c, info(), update);
	assert.equal(writes, 1);
	assert.equal(updates, 1);
	assert.equal(written.key, 'auth-uid:42');
	assert.deepEqual(written.data.tokens, ['valid']);
	assert.equal(written.options.expirationTtl, 30 * 24 * 60 * 60);
});

test('quota failures back off for 60 seconds and do not fail a valid session', async () => {
	let clock = Date.parse('2026-10-21T00:01:00Z');
	const renew = createSessionRefresher({ now: () => clock, onError() {} });
	let writes = 0;
	const c = { env: { kv: { async put() { writes++; throw new Error('429 quota exhausted'); } } } };
	await Promise.all(Array.from({ length: 20 }, () => renew(c, info(), async () => {})));
	assert.equal(writes, 1);
	clock += 59_999;
	await renew(c, info(), async () => {});
	assert.equal(writes, 1);
	clock++;
	await renew(c, info(), async () => {});
	assert.equal(writes, 2);
});

test('already renewed sessions skip persistence, and the next UTC day can renew again', async () => {
	let clock = Date.parse('2026-10-21T00:01:00Z');
	const renew = createSessionRefresher({ now: () => clock });
	let writes = 0;
	const c = { env: { kv: { async put() { writes++; } } } };
	await renew(c, { ...info(), refreshTime: new Date(clock).toISOString() }, async () => {});
	assert.equal(writes, 0);
	await renew(c, info(), async () => {});
	clock += 24 * 60 * 60 * 1000;
	await renew(c, info(), async () => {});
	assert.equal(writes, 2);
});

test('renewal process state stays bounded and does not leak between environments', async () => {
	const renew = createSessionRefresher({ now: () => Date.parse('2026-10-21T00:01:00Z') });
	let writes = 0;
	const c = { env: { kv: { async put() { writes++; } } } };
	for (let userId = 1; userId <= 300; userId++) {
		await renew(c, { ...info(), user: { userId } }, async () => {});
	}
	await renew(c, { ...info(), user: { userId: 300 } }, async () => {});
	assert.equal(writes, 300);
	await renew(c, { ...info(), user: { userId: 1 } }, async () => {});
	assert.equal(writes, 301);
	await renew({ env: { kv: c.env.kv } }, { ...info(), user: { userId: 300 } }, async () => {});
	assert.equal(writes, 302);
});

test('actual middleware still rejects a revoked token after successful renewal', async () => {
	let middleware;
	let current = info();
	let reads = 0;
	let nextCalls = 0;
	const renew = createSessionRefresher({ now: () => Date.parse('2026-10-21T00:01:00Z') });
	await loadService('../src/security/security.js', {
		app: { use(_path, fn) { middleware = fn; } },
		jwtUtils: { verifyToken: async () => ({ userId: 42, token: 'valid' }) },
		KvConst: { AUTH_INFO: 'auth-uid:' },
		constant: { TOKEN_HEADER: 'Authorization' },
		BizError: Error,
		t: key => key,
		userService: { updateUserInfo: async () => {} },
		refreshSession: renew
	});
	const c = { req: { path: '/my/info', header: () => 'signed-jwt' }, set() {}, env: { kv: {
		async get() { reads++; return structuredClone(current); },
		async put() {}
	} } };
	await middleware(c, async () => { nextCalls++; });
	current = { ...info(), tokens: [] };
	await assert.rejects(middleware(c, async () => { nextCalls++; }), /authExpired/);
	assert.equal(reads, 2);
	assert.equal(nextCalls, 1);
});

test('actual middleware reaches protected handler when only an optional TTL put fails', async () => {
	let middleware;
	const renew = createSessionRefresher({ now: () => Date.parse('2026-10-21T00:01:00Z'), onError() {} });
	await loadService('../src/security/security.js', {
		app: { use(_path, fn) { middleware = fn; } },
		jwtUtils: { verifyToken: async () => ({ userId: 42, token: 'valid' }) },
		KvConst: { AUTH_INFO: 'auth-uid:' }, constant: { TOKEN_HEADER: 'Authorization' },
		BizError: Error, t: key => key, userService: { updateUserInfo: async () => {} }, refreshSession: renew
	});
	const c = { req: { path: '/my/info', header: () => 'signed-jwt' }, set() {}, env: { kv: {
		async get() { return info(); }, async put() { throw new Error('429 quota'); }
	} } };
	assert.equal(await middleware(c, async () => 'protected response'), 'protected response');
});
