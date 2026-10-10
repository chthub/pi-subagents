/**
 * pi-subagents — user configuration.
 *
 * One JSON file, `<agentDir>/pi-subagents.json` (agentDir follows pi's own
 * PI_CODING_AGENT_DIR), or the path in PI_SUBAGENT_CONFIG. Missing file =
 * defaults; unknown keys are ignored; an invalid value falls back to its
 * default with a warning.
 *
 *   { "maxDepth": 1 }
 *
 * maxDepth — how many levels of agents may exist below the main session.
 *   1 (default): the main session spawns sub-agents; sub-agents cannot spawn.
 *   2: sub-agents may spawn their own sub-agents, which cannot. And so on.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentConfig {
	maxDepth: number;
}

export const DEFAULT_CONFIG: SubagentConfig = { maxDepth: 1 };

export function configPath(): string {
	return process.env.PI_SUBAGENT_CONFIG || path.join(getAgentDir(), "pi-subagents.json");
}

/** Parse the file's text into a config (pure). */
export function parseConfig(text: string): { config: SubagentConfig; warnings: string[] } {
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			config,
			warnings: [`not valid JSON (${err instanceof Error ? err.message : String(err)}); using defaults`],
		};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config, warnings: ["expected a JSON object; using defaults"] };
	}
	const { maxDepth } = raw as Record<string, unknown>;
	if (maxDepth !== undefined) {
		if (typeof maxDepth === "number" && Number.isInteger(maxDepth) && maxDepth >= 1) config.maxDepth = maxDepth;
		else warnings.push(`maxDepth must be an integer >= 1 (got ${JSON.stringify(maxDepth)}); using ${config.maxDepth}`);
	}
	return { config, warnings };
}

/** Read the config file; a missing file is the defaults, silently. */
export function loadConfig(file = configPath()): { config: SubagentConfig; warnings: string[] } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { config: { ...DEFAULT_CONFIG }, warnings: [] };
	}
	const parsed = parseConfig(text);
	return { config: parsed.config, warnings: parsed.warnings.map((w) => `${file}: ${w}`) };
}

/** Parse a non-negative integer from an env value, else undefined. */
export function envInt(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Whether an agent at `depth` (0 = the main session) may spawn. The main
 * session's limit travels down the tree (PI_SUBAGENT_MAX_DEPTH), so one file
 * governs the whole tree even if a child would read a different one.
 */
export function canSpawnAt(depth: number, maxDepth: number): boolean {
	return depth < maxDepth;
}
