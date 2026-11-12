import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { todaySendTotal } from '../src/service/send-statistics.mjs';

test('counts recipients from current UTC sent records, including soft-deleted sent messages', async () => {
	const sqlite = new DatabaseSync(':memory:');
	try {
		sqlite.exec('CREATE TABLE email (type INTEGER, recipient TEXT, create_time TEXT, is_del INTEGER DEFAULT 0, status INTEGER DEFAULT 1)');
		const insert = sqlite.prepare("INSERT INTO email(type, recipient, create_time, is_del) VALUES (?, ?, datetime('now', ?), ?)");
		insert.run(1, '[{"address":"first@example.test"},{"address":"second@example.test"}]', '0 seconds', 0);
		insert.run(1, '[{"address":"deleted@example.test"}]', '0 seconds', 1);
		insert.run(0, '[{"address":"incoming@example.test"}]', '0 seconds', 0);
		insert.run(1, '[{"address":"past@example.test"}]', '-1 day', 0);
		insert.run(1, '[{"address":"future@example.test"}]', '+1 day', 0);
		sqlite.exec("INSERT INTO email(type,recipient,create_time,status) VALUES (1, '[1,2,3]', datetime('now'), 6), (1, '[1,2,3]', datetime('now'), 8)");
		const db = { prepare(sql) { return { async first(key) { return sqlite.prepare(sql).get()[key]; } }; } };
		assert.equal(await todaySendTotal(db), 3);
	} finally {
		sqlite.close();
	}
});

test('returns zero for no sent messages and handles legacy malformed recipient fields', async () => {
	const sqlite = new DatabaseSync(':memory:');
	try {
		sqlite.exec('CREATE TABLE email (type INTEGER, recipient TEXT, create_time TEXT, status INTEGER DEFAULT 1)');
		const db = { prepare(sql) { return { async first(key) { return sqlite.prepare(sql).get()[key]; } }; } };
		assert.equal(await todaySendTotal(db), 0);
		const insert = sqlite.prepare("INSERT INTO email(type, recipient, create_time) VALUES (1, ?, datetime('now'))");
		insert.run(null);
		insert.run('not JSON');
		insert.run('{}');
		insert.run('[]');
		assert.equal(await todaySendTotal(db), 3);
	} finally {
		sqlite.close();
	}
});
