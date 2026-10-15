import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_LAUNCH_EVENT = "pi-subagents:child-launch:v1";

/** Synchronous, launch-only integration data; never saved in the roster or transcript. */
export interface ChildLaunch {
	env: Record<string, string>;
	extensions: string[];
	/** A listener's fail-closed signal. Use generic text only, never paths or credentials. */
	error?: string;
}

/** Emit immediately before construction. Identity overrides all injected environment values. */
export function prepareChildLaunch(
	events: Pick<ExtensionAPI["events"], "emit">,
	identity: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; extensions: string[] } {
	const launch: ChildLaunch = { env: {}, extensions: [] };
	// Do not catch emitter failures. Pi itself catches listener exceptions: listeners
	// must catch their own failures and set error synchronously to prevent a launch.
	events.emit(CHILD_LAUNCH_EVENT, launch);
	if ("error" in launch) {
		if (typeof launch.error !== "string") throw new TypeError(`${CHILD_LAUNCH_EVENT}: error must be a string`);
		// Never echo untrusted listener text into tool results or saved sessions.
		throw new Error(`${CHILD_LAUNCH_EVENT}: child launch rejected by integration`);
	}
	if (
		launch.env === null ||
		typeof launch.env !== "object" ||
		![Object.prototype, null].includes(Object.getPrototypeOf(launch.env))
	) {
		throw new TypeError(`${CHILD_LAUNCH_EVENT}: env must be a string record`);
	}
	for (const key of Reflect.ownKeys(launch.env)) {
		if (
			typeof key !== "string" ||
			key.length === 0 ||
			key.includes("=") ||
			key.includes("\0") ||
			typeof launch.env[key] !== "string" ||
			launch.env[key].includes("\0")
		) {
			throw new TypeError(`${CHILD_LAUNCH_EVENT}: env must contain valid string entries`);
		}
	}
	if (!Array.isArray(launch.extensions)) {
		throw new TypeError(`${CHILD_LAUNCH_EVENT}: extensions must be an array of paths`);
	}
	for (const path of launch.extensions) {
		if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) {
			throw new TypeError(`${CHILD_LAUNCH_EVENT}: extensions must contain nonempty string paths`);
		}
	}
	// Snapshot before returning: later/async listener mutations must not affect a child.
	return { env: { ...launch.env, ...identity }, extensions: [...launch.extensions] };
}
