// Sent messages already persist their recipients in D1. A separate KV counter
// can fail after delivery has succeeded and incorrectly report a failed send.
export const TODAY_SEND_TOTAL_SQL = `
	SELECT COALESCE(SUM(
		CASE WHEN json_valid(recipient) THEN
			CASE WHEN json_type(recipient) = 'array' THEN json_array_length(recipient) ELSE 1 END
		ELSE 1 END
	), 0) AS total
	FROM email
	WHERE type = 1
		AND status IN (1, 2, 3, 4, 5)
		AND create_time >= date('now')
		AND create_time < date('now', '+1 day')
`;

export async function todaySendTotal(db) {
	return Number(await db.prepare(TODAY_SEND_TOTAL_SQL).first('total')) || 0;
}
