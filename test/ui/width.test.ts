import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { capPlain, clipTail, safeTitle, structRow } from "../../ui/width.js";

describe("capPlain", () => {
	it("keeps short text as-is", () => {
		assert.equal(capPlain("hello", 10), "hello");
	});
	it("cuts long text to max columns with an ellipsis", () => {
		const out = capPlain("x".repeat(60), 40);
		assert.equal(visibleWidth(out), 40);
		assert.ok(out.endsWith("\u2026"));
	});
	it("measures CJK by terminal columns, not chars", () => {
		const out = capPlain("\u8c03".repeat(30), 20);
		assert.ok(visibleWidth(out) <= 20);
		assert.ok(out.endsWith("\u2026"));
	});
});

describe("head/tail width budgets", () => {
	for (const [name, clip] of [
		["capPlain", capPlain],
		["clipTail", clipTail],
		["safeTitle", safeTitle],
	] as const) {
		it(`${name} returns nothing for a zero-column budget`, () => {
			assert.equal(clip("abc", 0), "");
			assert.equal(clip("", 0), "");
		});

		it(`${name} respects small budgets with CJK, emoji and combining marks`, () => {
			for (const text of [
				"abc",
				"\u8c03\u7814".repeat(10),
				"👨‍👩‍👧".repeat(10),
				"🇨🇳".repeat(10),
				"e\u0301".repeat(10),
			]) {
				for (let width = 0; width <= 12; width++) {
					const out = clip(text, width);
					assert.ok(visibleWidth(out) <= width, `${name}(${JSON.stringify(text)}, ${width}): ${JSON.stringify(out)}`);
				}
			}
			assert.equal(clip("abc", 1), "…");
		});
	}

	it("preserves complete graphemes at either clipping boundary", () => {
		for (const grapheme of ["👨‍👩‍👧", "🇨🇳", "e\u0301"]) {
			const width = visibleWidth(grapheme) + 1;
			assert.equal(capPlain(grapheme.repeat(5), width), `${grapheme}…`);
			assert.equal(clipTail(grapheme.repeat(5), width), `…${grapheme}`);
		}
	});
});

describe("structRow", () => {
	const styled = (s: string) => `\x1b[36m${s}\x1b[0m`;

	it("assembles prefix + content + suffix", () => {
		const out = structRow({ prefix: " ⠋ ", content: "task", suffix: " (5s)", width: 80 });
		assert.equal(out, " ⠋ task (5s)");
	});

	it("never exceeds the terminal width, however long the content", () => {
		const out = structRow({
			prefix: styled(" ⠋ "),
			content: "x".repeat(500),
			suffix: styled(" (1m 40s)"),
			width: 80,
			styleContent: styled,
		});
		assert.ok(visibleWidth(out) <= 80, `width ${visibleWidth(out)} > 80`);
	});

	it("skips ANSI codes when measuring prefix/suffix", () => {
		const plain = structRow({ prefix: " ab ", content: "c", width: 80 });
		const ansi = structRow({ prefix: styled(" ab "), content: "c", width: 80 });
		assert.equal(visibleWidth(plain), visibleWidth(ansi));
	});

	it("flattens newlines and tabs (zero-width collapse would lie about fit)", () => {
		const out = structRow({ prefix: "", content: "a\nb\tc", width: 80 });
		assert.equal(out, "a b c");
		assert.ok(!out.includes("\n"));
	});

	it("keep tail sacrifices the head for activity streams", () => {
		const out = structRow({ prefix: "", content: "0123456789".repeat(10), width: 12, keep: "tail" });
		assert.equal(visibleWidth(out), 12);
		assert.ok(out.startsWith("\u2026"));
	});

	it("degenerate width still emits a safe line", () => {
		for (const suffix of [undefined, " (5s)"]) {
			const out = structRow({ prefix: "   ", content: "abc", suffix, width: 2 });
			assert.ok(visibleWidth(out) <= 2);
		}
	});

	it("budgets long styled prefixes and suffixes, even at zero/one column", () => {
		for (const prefix of ["", "   ", styled("prefix ".repeat(10)), styled("\u8c03👨‍👩‍👧")]) {
			for (const suffix of ["", " (5s)", styled("suffix ".repeat(10)), styled("🇨🇳\u8c03")]) {
				for (const keep of ["head", "tail"] as const) {
					for (let width = 0; width <= 20; width++) {
						const out = structRow({
							prefix,
							content: "\u8c03👨‍👩‍👧abc".repeat(10),
							suffix,
							width,
							keep,
							styleContent: styled,
						});
						assert.ok(visibleWidth(out) <= width, `width ${visibleWidth(out)} > ${width}: ${JSON.stringify(out)}`);
					}
				}
			}
		}
	});

	it("keeps metadata when only the structural text fits", () => {
		assert.equal(structRow({ prefix: "   ", content: "abc", suffix: " (5s)", width: 5 }), " (5s)");
		const out = structRow({ prefix: "   ", content: "abc", suffix: " (5s)", width: 7 });
		assert.equal(visibleWidth(out), 7);
		assert.ok(out.endsWith(" (5s)"));
	});
});
