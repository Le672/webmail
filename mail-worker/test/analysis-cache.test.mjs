import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisCache, normalizeTimeZone } from '../src/service/analysis-cache.mjs';

function context(analysis_cache = true) {
	return {
		env: { analysis_cache, kv: { put() { throw new Error('KV writes must not be used for statistics'); }, list() { throw new Error('KV enumeration must not be used for statistics'); } } },
		req: { url: 'https://mail.yukino.bond/api/analysis/echarts' }
	};
}

test('validates and canonicalizes time zones, including malformed input', () => {
	assert.equal(normalizeTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
	assert.equal(normalizeTimeZone('US/Eastern'), normalizeTimeZone('America/New_York'));
	for (const value of ['not-a-zone', '', '../../keys', undefined, {}, null]) {
		assert.equal(normalizeTimeZone(value), 'UTC');
	}
});

test('coalesces concurrent requests and expires derived data after 15 minutes without KV writes', async () => {
	let clock = 1000;
	const cached = createAnalysisCache({ now: () => clock, edgeCache: () => undefined });
	const c = context();
	let calls = 0;
	const query = async ({ timeZone }) => ({ calls: ++calls, timeZone });
	const results = await Promise.all(Array.from({ length: 20 }, () => cached(c, { timeZone: 'Asia/Shanghai' }, query)));
	assert.equal(calls, 1);
	assert.ok(results.every(value => value.calls === 1));
	clock += 15 * 60 * 1000;
	assert.equal((await cached(c, { timeZone: 'Asia/Shanghai' }, query)).calls, 2);
});

test('edge cache works across fresh instances without extending the original expiry', async () => {
	let clock = 1000;
	const store = new Map();
	const edge = {
		async match(request) { return store.get(request.url)?.clone(); },
		async put(request, response) { store.set(request.url, response.clone()); }
	};
	const options = { now: () => clock, edgeCache: () => edge };
	let calls = 0;
	const query = async () => ({ count: ++calls });
	await createAnalysisCache(options)(context(), { timeZone: 'UTC' }, query);
	clock += 14 * 60 * 1000;
	const c = context();
	const fresh = createAnalysisCache(options);
	assert.equal((await fresh(c, { timeZone: 'UTC' }, query)).count, 1);
	clock += 60 * 1000;
	assert.equal((await fresh(c, { timeZone: 'UTC' }, query)).count, 2);
	assert.equal(calls, 2);
});

test('optional edge cache errors do not hide the D1 result', async () => {
	const cached = createAnalysisCache({ edgeCache: () => ({
		async match() { throw new Error('cache unavailable'); },
		async put() { throw new Error('cache full'); }
	}) });
	assert.deepEqual(await cached(context(), {}, async () => ({ total: 7 })), { total: 7 });
});

test('failed queries can be retried, and disabled caching still validates the time zone', async () => {
	const cached = createAnalysisCache({ edgeCache: () => undefined });
	const c = context();
	await assert.rejects(cached(c, {}, async () => { throw new Error('D1 transient'); }), /D1 transient/);
	assert.equal(await cached(c, {}, async () => 4), 4);
	let calls = 0;
	const disabled = context(false);
	for (let i = 0; i < 2; i++) {
		await cached(disabled, { timeZone: 'invalid' }, async ({ timeZone }) => {
			assert.equal(timeZone, 'UTC');
			calls++;
		});
	}
	assert.equal(calls, 2);
});

test('keeps the process cache bounded when many valid time zones are requested', async () => {
	const zones = Intl.supportedValuesOf('timeZone').slice(0, 40);
	const cached = createAnalysisCache({ edgeCache: () => undefined });
	const c = context();
	let calls = 0;
	const query = async () => ++calls;
	for (const timeZone of zones) await cached(c, { timeZone }, query);
	assert.equal(calls, 40);
	await cached(c, { timeZone: zones[0] }, query);
	assert.equal(calls, 41);
	await cached(c, { timeZone: zones.at(-1) }, query);
	assert.equal(calls, 41);
});
