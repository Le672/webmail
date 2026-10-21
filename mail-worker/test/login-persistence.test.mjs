import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from './service-harness.mjs';

async function fixture(blocked) {
	const now = '2026-10-21T00:01:00Z';
	let written;
	const authInfo = { user: { userId: 42, email: 'user@yukino.bond' }, tokens: ['existing'], refreshTime: '2026-10-19T00:00:00Z' };
	const service = await loadService('../src/service/login-service.js', {
		userService: { selectByEmailIncludeDel: async () => ({ userId: 42, email: 'user@yukino.bond', isDel: 0, status: 0 }), updateUserInfo: async () => {} },
		isDel: { DELETE: 1 }, userConst: { status: { BAN: 1 } },
		cryptoUtils: { verifyPassword: async () => true },
		uuidv4: () => 'new-session', JwtUtils: { generateToken: async () => 'signed-jwt' },
		KvConst: { AUTH_INFO: 'auth-uid:' }, constant: { TOKEN_EXPIRE: 30 * 24 * 60 * 60 },
		userContext: { getToken: () => 'existing' },
		dayjs: () => ({ toISOString: () => now }), BizError: Error, t: key => key
	});
	const c = { env: { kv: {
		async get() { return structuredClone(authInfo); },
		async put(_key, value) {
			if (blocked) throw new Error('429 KV exhausted');
			written = JSON.parse(value);
		}
	} } };
	return { service, c, now, written: () => written };
}

test('successful login marks the session renewed today and retains existing sessions', async () => {
	const f = await fixture(false);
	assert.equal(await f.service.login(f.c, { email: 'user@yukino.bond', password: 'example' }), 'signed-jwt');
	assert.equal(f.written().refreshTime, f.now);
	assert.deepEqual(f.written().tokens, ['existing', 'new-session']);
});

test('new login and logout never report success without persisting the token list', async () => {
	const f = await fixture(true);
	await assert.rejects(f.service.login(f.c, { email: 'user@yukino.bond', password: 'example' }), /429 KV exhausted/);
	await assert.rejects(f.service.logout(f.c, 42), /429 KV exhausted/);
});
