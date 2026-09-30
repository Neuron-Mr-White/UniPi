/**
 * @pi-unipi/kanboard — debug log (~/.unipi/logs/kanboard.log when
 * UNIPI_DEBUG_KANBOARD=1, silent otherwise).
 */

export function createDebugLog(env: NodeJS.ProcessEnv = process.env): (line: string) => void {
	if (env.UNIPI_DEBUG_KANBOARD !== "1") return () => undefined;
	return (line: string) => {
		try {
			// Lazy require: keeps node:fs/node:os out of the module graph.
			const { appendFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
			const { homedir } = require("node:os") as typeof import("node:os");
			const dir = `${homedir()}/.unipi/logs`;
			mkdirSync(dir, { recursive: true });
			appendFileSync(`${dir}/kanboard.log`, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// best-effort
		}
	};
}
