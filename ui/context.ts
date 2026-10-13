/**
 * LLM context protection — the shared stash primitive.
 *
 * Agent results use one contract: the LLM sees a capped preview, and when
 * content was cut the full text is stashed in /tmp so it's one `read` away.
 * Budget is pi-bash parity (2000 lines / 50KB, whichever hits first) via
 * pi's own truncateHead/truncateTail.
 *
 * The internal UI layer uses this helper to protect model context;
 * storage and truncation are independent of terminal rendering.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

interface ContextStash {
	/** Capped preview text (LLM-visible). */
	text: string;
	/** Full-text path when truncated; undefined when the text fit. */
	stashPath?: string;
}

/** Inline marker for a stash path — callers append it to LLM-visible text. */
export function truncationMarker(stashPath: string): string {
	return `\n\n(output truncated — full output: ${stashPath})`;
}

let stashDirectory: string | undefined;
const stashes = new Map<string, string>();

/**
 * Cap `fullText` to the context budget; on truncation write the full text
 * into a private temporary directory. Different full texts never overwrite
 * one another; identical reports can reuse their path within this runtime.
 * Files survive runtime shutdown so saved result markers remain readable.
 * Write failures are best-effort: the caller still gets the capped preview.
 *
 * @param key stable identifier combined with the full content (agent id, url…)
 * @param opts.keep "head" keeps the beginning (documents), "tail" keeps the
 *   latest (activity output, pi-bash style). Default "head".
 */
export function stashOverflow(fullText: string, key: string, opts?: { keep?: "head" | "tail" }): ContextStash {
	const result = opts?.keep === "tail" ? truncateTail(fullText) : truncateHead(fullText);
	if (!result.truncated) return { text: result.content };
	const digest = createHash("sha256")
		.update(`${Buffer.byteLength(key)}:`)
		.update(key)
		.update(fullText)
		.digest("hex");
	try {
		const cached = stashes.get(digest);
		if (cached && existsSync(cached)) return { text: result.content, stashPath: cached };
		if (!stashDirectory || !existsSync(stashDirectory)) stashDirectory = mkdtempSync(join(tmpdir(), "pi-stash-"));
		const file = join(stashDirectory, `${digest}.txt`);
		writeFileSync(file, fullText, { encoding: "utf8", flag: "wx", mode: 0o600 });
		stashes.set(digest, file);
		return { text: result.content, stashPath: file };
	} catch {
		return { text: result.content }; // best-effort: never break the caller
	}
}
