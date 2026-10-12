/**
 * Loads the extension under the process env and prints the tools it
 * registers as JSON. The agent identity (PI_SUBAGENT_AGENT_ID) is read at
 * module load, so a child's registration is only observable in a fresh process.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../index.js";

const tools: { name: string; defaultActive?: boolean; description: string; parameters: unknown }[] = [];
extension({
	on: () => () => {},
	registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
	registerCommand() {},
	registerMessageRenderer() {},
	registerToolRenderer() {},
} as unknown as ExtensionAPI);
process.stdout.write(JSON.stringify(tools));
