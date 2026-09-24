import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../../../src/core/tools/bash.ts";

/**
 * Regression test for the bash truncation notice.
 *
 * When the last line of the captured output is larger than the byte limit and ends with a
 * newline, the notice must report that line's real size. The size came from
 * `getLastLineBytes()`, which only counts the bytes after the final newline, so it reported
 * `0B` for a line that was fully present — a value smaller than the slice being shown in the
 * same sentence.
 *
 * `#134` specifies this case as `[Showing last 50KB of line N (line is XKB). ...]`, where X is
 * the line's real size.
 */
describe("bash truncation notice line size", () => {
	it("reports the real size of a >50KB last line that ends with a newline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bash-notice-"));
		try {
			// One line of 60000 bytes plus a newline (60001 bytes total, 58.6KB).
			const script = join(dir, "bigline.mjs");
			writeFileSync(script, `process.stdout.write("a".repeat(60000) + "\\n");\n`);

			const tool = createBashTool(dir);
			const result = await tool.execute("bigline", { command: `node ${JSON.stringify(script)}` });
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");

			const notice = text.split("\n").find((line) => line.startsWith("[Showing last"));

			expect(notice, `no partial-line notice in output: ${text.slice(-200)}`).toBeDefined();
			// The line is 60001 bytes, which formatSize renders as 58.6KB at 1024 bytes per KB.
			expect(notice).toContain("line is 58.6KB");
			// The size must never be smaller than the slice being shown in the same sentence.
			expect(notice).not.toContain("line is 0B");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
