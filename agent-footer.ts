/**
 * pi-subagents — the agent view's footer: pi's own footer, about a child.
 *
 * pi's FooterComponent renders the main session's footer (cwd + git branch +
 * session name, token/cost/context stats + model, extension statuses). The
 * agent view shows the same lines for one sub-agent by handing that
 * component the child's data: its session file (usage totals, cwd, name),
 * its live rpc state (model, thinking, context usage) and the statuses its
 * extensions set. Reusing the component keeps the layout identical to the
 * main footer instead of imitating it.
 *
 * FooterComponent takes an AgentSession; it reads only the members built in
 * childSession below. A pi update that reads more would throw — render then
 * falls back to a plain line rather than breaking the view.
 */

import { execFile } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ContextUsage,
	calculateContextTokens,
	FooterComponent,
	getLastAssistantUsage,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Everything the footer shows about one child. */
export interface AgentFooterData {
	/** The child's session (usage totals, cwd, session name). */
	sessionManager: SessionManager;
	model?: Model<Api>;
	thinkingLevel?: string;
	contextUsage?: ContextUsage;
	autoCompactionEnabled: boolean;
	gitBranch: string | null;
	/** Providers with available models — more than one prefixes the model with its provider. */
	providerCount: number;
	isUsingSubscription(provider: string): boolean;
	/** The child's extension statuses, read at render time (they change between refreshes). */
	statuses(): ReadonlyMap<string, string>;
}

/** The AgentSession members FooterComponent reads, built from a child's data. */
function childSession(data: AgentFooterData) {
	return {
		sessionManager: data.sessionManager,
		state: { model: data.model, thinkingLevel: data.thinkingLevel },
		model: data.model,
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: (provider: string) => data.isUsingSubscription(provider) },
		getContextUsage: () => data.contextUsage,
	};
}

export class AgentFooter {
	private footer: FooterComponent | undefined;
	private data: AgentFooterData | undefined;

	/** New data from a refresh; the component recomputes its totals once for it. */
	update(data: AgentFooterData | undefined): void {
		this.data = data;
		if (!data) {
			this.footer = undefined;
			return;
		}
		const footerData = {
			getGitBranch: () => data.gitBranch,
			getExtensionStatuses: () => data.statuses(),
			getAvailableProviderCount: () => data.providerCount,
			onBranchChange: () => () => {},
		};
		this.footer = new FooterComponent(childSession(data) as never, footerData);
		this.footer.setAutoCompactEnabled(data.autoCompactionEnabled);
	}

	render(width: number): string[] {
		if (!this.footer || !this.data) return [];
		try {
			return this.footer.render(width);
		} catch {
			const model = this.data.model ? `${this.data.model.provider}/${this.data.model.id}` : "";
			return [truncateToWidth(` ${this.data.sessionManager.getCwd()}  ${model}`, width, "…")];
		}
	}
}

/**
 * Context usage of a child with no live process to ask: its last assistant
 * reply's prompt size. pi's live figure also estimates messages after that
 * reply; a finished child's conversation ends with the reply itself.
 */
export function finishedContextUsage(
	sessionManager: SessionManager,
	model: Model<Api> | undefined,
): ContextUsage | undefined {
	const contextWindow = model?.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;
	const usage = getLastAssistantUsage(sessionManager.getBranch());
	if (!usage) return { tokens: null, contextWindow, percent: null };
	const tokens = calculateContextTokens(usage);
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/** The checked-out branch at `cwd` ("detached" for a detached HEAD), or null outside a repository. */
export function gitBranch(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 }, (error, stdout) => {
			if (error) return resolve(null);
			const branch = stdout.trim();
			resolve(branch === "HEAD" ? "detached" : branch || null);
		});
	});
}
