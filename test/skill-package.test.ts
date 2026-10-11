import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, formatSkillsForPrompt, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillPath = join(root, "skills", "pi-subagents-workflow", "SKILL.md");

async function resources(t: TestContext, options: { disablePackageSkill?: boolean; noSkills?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-skill-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory({
			packages: [{ source: root, extensions: [], ...(options.disablePackageSkill ? { skills: [] } : {}) }],
		}),
		noExtensions: true,
		noSkills: options.noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader;
}

test("package exposes skill metadata at startup without enabling agent tools or injecting its body", async (t) => {
	const loader = await resources(t);
	const { skills, diagnostics } = loader.getSkills();
	assert.deepEqual(
		diagnostics.filter((d) => d.path === skillPath),
		[],
	);
	const packaged = skills.filter((skill) => skill.filePath === skillPath);
	assert.equal(packaged.length, 1);
	assert.equal(packaged[0].name, "pi-subagents-workflow");
	assert.equal(loader.getExtensions().extensions.length, 0, "skill discovery does not require tool activation");
	const prompt = formatSkillsForPrompt(packaged);
	assert.match(prompt, /Coordinate delegated work with agent_spawn, agent_send, and agent_stop/);
	assert.ok(prompt.includes(skillPath));
	assert.doesNotMatch(prompt, /Only one agent may change|Avoid unnecessary messages and stops/);
});

test("package skill filters and noSkills remain authoritative", async (t) => {
	for (const options of [{ disablePackageSkill: true }, { noSkills: true }]) {
		const { skills } = (await resources(t, options)).getSkills();
		assert.equal(
			skills.some((skill) => skill.filePath === skillPath),
			false,
		);
	}
});

test("coordination has one source in the packaged skill and does not define preset agent roles", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills/"));
	const skill = readFileSync(skillPath, "utf8");
	for (const heading of [
		"Specify the task",
		"Parallelize independent work",
		"Keep file changes separate",
		"Continue related work",
		"Avoid unnecessary messages and stops",
		"Check what is missing",
	]) {
		assert.ok(skill.includes(`**${heading}.**`), heading);
	}
	assert.match(skill, /Only one agent may change a given file at a time, including the main agent/);
	assert.match(skill, /read-only unless edits were explicitly assigned/);
	assert.doesNotMatch(skill, /\b(scout|worker|reviewer|author|writer)\b/i);
	assert.doesNotMatch(skill, /final reply is returned|response and tool batch|Starts a new model turn/);
});
