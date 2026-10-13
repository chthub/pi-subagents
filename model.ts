/**
 * pi-subagents — model resolution.
 *
 * Resolve a user-provided model spec against the ModelRegistry.
 * Supported forms:
 *   - undefined      → inherit parent session model (no lookup)
 *   - "name"         → match by model id (any provider) — case-insensitive substring
 *   - "provider/id"  → prefer exact provider, then loose match
 *
 * When the requested model is unavailable the caller gets an error string
 * and returns an isError result. No implicit fallback/downgrade.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ResolvedModel {
	/** Canonical "provider/id" string to pass to the child pi, or undefined to inherit. */
	model?: string;
	/** Set when the user explicitly requested a model that was not found in the registry. */
	error?: string;
}

/** Normalize a model or provider token for loose matching: lowercased, punctuation flattened. */
function normalize(s: string): string {
	return s.toLowerCase().replace(/[._:]+/g, "-");
}

interface ModelLite {
	provider: string;
	id: string;
}

/** Cap on suggested models, so a large registry does not flood the error. */
const MAX_SUGGESTIONS = 8;

/**
 * Appended to a not-available error: the models sharing the most name tokens
 * with the request, or the provider list when none share any.
 */
function suggestModels(available: readonly ModelLite[], requested: string): string {
	const tokens = (s: string) =>
		normalize(s)
			.split(/[^a-z0-9]+/)
			.filter(Boolean);
	const wanted = new Set(tokens(requested));
	const ranked = available
		.map((m) => ({
			name: `${m.provider}/${m.id}`,
			score: tokens(`${m.provider}/${m.id}`).filter((t) => wanted.has(t)).length,
		}))
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_SUGGESTIONS);
	if (ranked.length > 0) return ` Closest available: ${ranked.map((m) => m.name).join(", ")}.`;
	return ` Available providers: ${[...new Set(available.map((m) => m.provider))].join(", ")}.`;
}

/**
 * Resolve `originalModel` against `registry`; inherit `fallback` only when
 * no model was requested. Exact provider/id matches precede loose matches.
 * `fallback` is the parent's `Model`-shaped object or undefined.
 */
export function resolveModel(
	registry: ModelRegistry,
	fallback: ModelLite | undefined | null,
	originalModel?: string,
): ResolvedModel {
	const fallbackStr = fallback ? `${fallback.provider}/${fallback.id}` : undefined;

	if (!originalModel) return { model: fallbackStr };

	const available = registry.getAvailable();
	if (available.length === 0) {
		return { error: `No models available in registry.` };
	}

	const sep = originalModel.indexOf("/");
	const providerHint = sep >= 0 ? originalModel.slice(0, sep) : undefined;
	const modelName = sep >= 0 ? originalModel.slice(sep + 1) : originalModel;
	if (!modelName.trim()) {
		// "provider/" with nothing after the slash matches nothing — an
		// empty model name would otherwise be an `includes("")` truthy
		// substring match against every model.
		return { error: `Model "${originalModel}" not available.${suggestModels(available, originalModel)}` };
	}
	const requestedId = modelName.trim().toLowerCase();
	const normModel = normalize(requestedId);
	const select = (candidates: ModelLite[]): ModelLite | undefined =>
		candidates.find((m) => m.id.toLowerCase() === requestedId) ??
		candidates.find((m) => normalize(m.id) === normModel) ??
		candidates.find((m) => normalize(m.id).includes(normModel));

	let match: ModelLite | undefined;
	if (providerHint) {
		const requestedProvider = providerHint.trim().toLowerCase();
		const normProvider = normalize(requestedProvider);
		match =
			select(available.filter((m) => m.provider.toLowerCase() === requestedProvider)) ??
			select(available.filter((m) => normalize(m.provider) === normProvider)) ??
			select(available.filter((m) => normalize(m.provider).includes(normProvider)));
	}
	match ??= select(available);
	if (match) return { model: `${match.provider}/${match.id}` };

	return {
		error: `Model "${originalModel}" not available.${suggestModels(available, originalModel)}`,
	};
}
