/**
 * The Message types require `content` to always be present, but untyped JS
 * extension tools, hand-built histories, and old or hand-edited session files
 * can violate that contract. We are intentionally lax at the ingestion
 * boundaries and normalize null/missing content to an empty array so it never
 * reaches rendering, compaction, or provider request conversion
 * (issues #6259, #6276).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager, sessionEntryToContextMessages } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

function messageEntry(message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

describe("lax message content handling", () => {
	it("normalizes tool results from untyped tools that omit content", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "web_search",
					label: "Web Search",
					description: "Custom tool that returns a result without content",
					parameters: Type.Object({}),
					// Simulate an untyped JS extension tool that omits content.
					execute: async () => ({ details: {} }) as unknown as AgentToolResult<unknown>,
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("search something");

			const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0].content).toEqual([]);
			// The follow-up turn consumed the normalized tool result without crashing.
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null content in message_end extension replacements", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role !== "assistant") return undefined;
					// Simulate an untyped JS extension replacing a message without content.
					return { message: { ...event.message, content: null } as unknown as AgentMessage };
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([fauxAssistantMessage("hello")]);
			await harness.session.prompt("hi");

			const assistantMessages = harness.session.messages.filter((message) => message.role === "assistant");
			expect(assistantMessages).toHaveLength(1);
			expect(assistantMessages[0].content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null content in custom messages from extensions", async () => {
		const harness = await createHarness();

		try {
			await harness.session.sendCustomMessage({
				customType: "test",
				content: null as unknown as string,
				display: false,
				details: undefined,
			});

			const customMessages = harness.session.messages.filter((message) => message.role === "custom");
			expect(customMessages).toHaveLength(1);
			expect(customMessages[0].content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null or missing content when loading session message entries", () => {
		const badMessages = [
			{ role: "user", content: null, timestamp: Date.now() },
			{
				role: "assistant",
				content: null,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
		];

		for (const badMessage of badMessages) {
			const [message] = sessionEntryToContextMessages(messageEntry(badMessage));
			expect(message).toMatchObject({ role: badMessage.role, content: [] });
		}
	});

	it("normalizes null content when loading custom message entries", () => {
		const entry = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "test",
			content: null,
			display: false,
			details: undefined,
		} as unknown as SessionEntry;

		const [message] = sessionEntryToContextMessages(entry);
		expect(message).toMatchObject({ role: "custom", content: [] });
	});

	it("keeps valid message content untouched when loading session entries", () => {
		const [message] = sessionEntryToContextMessages(
			messageEntry({ role: "user", content: "hello", timestamp: Date.now() }),
		);
		expect(message).toMatchObject({ role: "user", content: "hello" });
	});
});

/**
 * A `type:"message"` entry whose `message` field is missing or null violates the
 * SessionMessageEntry contract. `parseSessionEntries` skips only lines that fail
 * JSON.parse, so imported or hand-edited files can carry such an entry into every reader.
 * `_persist` dereferences `e.message.role` on every append, so one such line made
 * `appendMessage` throw on every turn; the entry had already been pushed into memory and
 * the leaf advanced, silently diverging the live tree from disk.
 */
describe("message entries missing their message field", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-lax-message-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeSessionFile(entries: unknown[]): string {
		const file = join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "sess-lax", timestamp: new Date().toISOString(), cwd: dir };
		writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	function userEntry(id: string, parentId: string | null, text: string) {
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: text, timestamp: Date.now() },
		};
	}

	it("loads a session containing an entry without a message field and keeps saving", () => {
		const file = writeSessionFile([
			userEntry("m1", null, "hello"),
			{ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString() },
		]);

		const sessionManager = SessionManager.open(file, dir);

		// Appending used to throw "Cannot read properties of undefined (reading 'role')"
		// from _persist() -> appendMessage() on every turn.
		expect(() =>
			sessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() } as never),
		).not.toThrow();

		// Building context used to throw from getSessionContextSettings().
		expect(() => sessionManager.buildSessionProjection()).not.toThrow();
	});

	it("does not let memory diverge from disk after the malformed entry", () => {
		const file = writeSessionFile([
			userEntry("m1", null, "hello"),
			{ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString() },
		]);

		const sessionManager = SessionManager.open(file, dir);
		sessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() } as never);

		const inMemoryIds = sessionManager.getEntries().map((entry) => entry.id);
		const onDiskIds = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { id?: string }).id)
			.filter((id): id is string => id !== undefined);

		// Every appended entry reached the file: no silent, unrecoverable divergence.
		expect(inMemoryIds.filter((id) => !onDiskIds.includes(id))).toEqual([]);
	});

	it("treats the missing message as inert rather than as model context", () => {
		const [message] = sessionEntryToContextMessages({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: new Date().toISOString(),
		} as unknown as SessionEntry);

		// Normalized to an empty system message: it must not invent a user or assistant turn
		// and must not carry any text into the prompt.
		expect(message).toMatchObject({ role: "system", content: "" });
	});
});
