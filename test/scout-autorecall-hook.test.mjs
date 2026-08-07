import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_MODE = process.env.PLURESLM_AUTORECALL_MODE;
const ORIGINAL_QUERY_HISTORY = process.env.PLURESLM_AUTORECALL_QUERY_HISTORY_MESSAGES;

let hook;

beforeAll(async () => {
  hook = await import("../scout-hooks/hooks/plureslm-autorecall-core.mjs");
});

afterEach(() => {
  if (ORIGINAL_MODE === undefined) {
    delete process.env.PLURESLM_AUTORECALL_MODE;
  } else {
    process.env.PLURESLM_AUTORECALL_MODE = ORIGINAL_MODE;
  }
  if (ORIGINAL_QUERY_HISTORY === undefined) {
    delete process.env.PLURESLM_AUTORECALL_QUERY_HISTORY_MESSAGES;
  } else {
    process.env.PLURESLM_AUTORECALL_QUERY_HISTORY_MESSAGES = ORIGINAL_QUERY_HISTORY;
  }
});

afterAll(() => {
  hook = undefined;
});

describe("Scout PluresLM autoRecall hook helpers", () => {
  it("extracts prompt and recent transcript without duplicating the submitted prompt", () => {
    const payload = {
      transcript: [
        { role: "user", content: "We decided to use PluresDB for Scout recall." },
        { role: "assistant", content: "I will wire the MCP server." },
        { role: "user", content: "Use that now" },
      ],
    };

    const prompt = hook.findPrompt(payload);
    const recent = hook.recentTranscriptMessages(payload, prompt, 5);

    expect(prompt).toBe("Use that now");
    expect(recent).toEqual([
      { role: "user", content: "We decided to use PluresDB for Scout recall." },
      { role: "assistant", content: "I will wire the MCP server." },
    ]);
  });

  it("treats short referential follow-ups as recall-worthy when transcript exists", () => {
    delete process.env.PLURESLM_AUTORECALL_MODE;
    const recent = [
      { role: "user", content: "Let's address the autoRecall fallback." },
    ];

    expect(hook.shouldRecall("fix that", recent)).toBe(true);
    expect(hook.shouldRecall("thanks", recent)).toBe(false);
    expect(hook.shouldRecall("recall prior decisions", [])).toBe(true);
  });

  it("seeds short follow-up recall queries with recent transcript context", () => {
    process.env.PLURESLM_AUTORECALL_QUERY_HISTORY_MESSAGES = "2";
    const recent = [
      { role: "user", content: "Older context that should be dropped." },
      { role: "assistant", content: "PluresDB MCP exposes plures_recall." },
      { role: "user", content: "Scout still needs automatic injection." },
    ];

    const query = hook.buildRecallQuery("implement that", recent);

    expect(query).not.toContain("Older context");
    expect(query).toContain("assistant: PluresDB MCP exposes plures_recall.");
    expect(query).toContain("user: Scout still needs automatic injection.");
    expect(query).toContain("user: implement that");
  });

  it("adds bounded recent transcript fallback when recall has no hits", () => {
    const context = hook.formatRecallContext(
      "what about that",
      [],
      { dbPath: "C:\\tmp\\pluresdb" },
      {
        recallQuery: "assistant: autoRecall fallback\nuser: what about that",
        fallbackMessages: [
          { role: "assistant", content: "autoRecall fallback should preserve context." },
        ],
      },
    );

    expect(context).toContain("<plureslm_autorecall>");
    expect(context).toContain("No matching PluresLM memories were found.");
    expect(context).toContain("Recent conversation fallback:");
    expect(context).toContain("autoRecall fallback should preserve context.");
  });

  it("does not include transcript fallback when recall returns memory hits", () => {
    const context = hook.formatRecallContext(
      "recall Scout work",
      [
        {
          id: "mem:1",
          score: 0.9,
          via: "vector",
          category: "memory-chunk",
          timestamp: "2026-07-17T00:00:00.000Z",
          snippet: "Scout uses PluresDB for recall.",
        },
      ],
      { dbPath: "C:\\tmp\\pluresdb" },
      {
        recallQuery: "recall Scout work",
        fallbackMessages: [
          { role: "assistant", content: "This should not be injected." },
        ],
      },
    );

    expect(context).toContain("Relevant memories:");
    expect(context).toContain("Scout uses PluresDB for recall.");
    expect(context).not.toContain("Recent conversation fallback:");
    expect(context).not.toContain("This should not be injected.");
  });
});
