import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Load the actual service/middleware body with explicit dependency doubles.
// This keeps these regressions independent of bundler and deployment tooling.
export async function loadService(relativePath, dependencies) {
	const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
	const sandbox = { ...dependencies };
	const body = source.replace(/^import .*$/gm, '').replace(/^export default (\w+);?\s*$/m, 'globalThis.loadedService = $1;');
	runInNewContext(body, sandbox, { filename: relativePath, timeout: 1000 });
	return sandbox.loadedService;
}
