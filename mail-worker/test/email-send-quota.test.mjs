import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from './service-harness.mjs';

async function fixture({ sendCount = 2, sendLimit = 10, providerError = false } = {}) {
	const stored = [];
	const counts = [];
	let deliveries = 0;
	let kvWrites = 0;
	const service = await loadService('../src/service/email-service.js', {
		orm: () => ({ insert: () => ({ values: value => ({ returning: () => ({ get: async () => {
			const row = { ...value, emailId: stored.length + 1 };
			stored.push(row);
			return row;
		} }) }) }) }),
		email: {},
		emailConst: { type: { SEND: 1 }, status: { DELIVERED: 2, SENT: 1 } },
		settingConst: { send: { CLOSE: 1 } },
		settingService: { query: async () => ({ resendTokens: {}, domainList: ['@yukino.bond'], send: 0 }) },
		attService: { toImageUrlHtml: async () => ({ imageDataList: [], html: '' }), selectByEmailIds: async () => [] },
		userService: { selectById: async () => ({ email: 'user@yukino.bond', type: 1, sendCount }), incrUserSendCount: async (_c, count, userId) => counts.push({ count, userId }) },
		roleService: { selectById: async () => ({ sendCount: sendLimit, sendType: 'day' }), hasAvailDomainPerm: () => true },
		accountService: { selectById: async () => ({ userId: 42, email: 'user@yukino.bond' }) },
		emailUtils: { getDomain: value => value.split('@')[1], getName: value => value.split('@')[0] },
		BizError: Error,
		t: value => value,
		// Retained doubles ensure the regression would reach the old KV put.
		dayjs: () => ({ format: () => '2026-10-21' }),
		kvConst: { SEND_DAY_COUNT: 'send_day_count:' }
	});
	service.sendByCloudflareEmail = async () => {
		deliveries++;
		return providerError ? { error: { message: 'delivery rejected' } } : { data: {} };
	};
	const c = { env: { email: {}, admin: 'admin@yukino.bond', kv: {
		async get() { return null; },
		async put() { kvWrites++; throw new Error('429 KV daily writes exhausted'); }
	} } };
	const params = { accountId: 5, receiveEmail: ['one@example.test', 'two@example.test'], subject: 'Example', content: '', text: 'Body' };
	return { service, c, params, stored, counts, deliveries: () => deliveries, kvWrites: () => kvWrites };
}

test('already delivered mail reports success even when KV puts are exhausted', async () => {
	const f = await fixture();
	const result = await f.service.send(f.c, f.params, 42);
	assert.equal(result.length, 1);
	assert.equal(result[0].emailId, 1);
	assert.equal(f.deliveries(), 1);
	assert.equal(f.kvWrites(), 0);
	assert.equal(f.stored[0].type, 1);
	assert.equal(f.stored[0].status, 2);
	assert.equal(JSON.parse(f.stored[0].recipient).length, f.params.receiveEmail.length);
	assert.deepEqual(f.counts, [{ count: 2, userId: 42 }]);
});

test('existing account send allowances still reject before delivery', async () => {
	const f = await fixture({ sendCount: 9 });
	await assert.rejects(f.service.send(f.c, f.params, 42), /daySendLack/);
	assert.equal(f.deliveries(), 0);
	assert.equal(f.stored.length, 0);
	assert.equal(f.kvWrites(), 0);
});

test('a real provider rejection remains a failure and creates no sent record', async () => {
	const f = await fixture({ providerError: true });
	await assert.rejects(f.service.send(f.c, f.params, 42), /delivery rejected/);
	assert.equal(f.stored.length, 0);
	assert.equal(f.counts.length, 0);
});
