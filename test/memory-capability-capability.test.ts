import { describe, expect, it } from "vitest";

import { buildMemoryCapability } from "../src/memory-capability.js";

describe("MemoryPluginCapability parity seams", () => {
  it("returns promptBuilder + flushPlanResolver + runtime", () => {
    const capability = buildMemoryCapability({});

    expect(typeof capability.promptBuilder).toBe("function");
    expect(typeof capability.flushPlanResolver).toBe("function");
    expect(typeof capability.runtime?.getMemorySearchManager).toBe("function");
    expect(typeof capability.runtime?.resolveMemoryBackendConfig).toBe("function");
  });

  it("promptBuilder emits section only when memory tools are available", () => {
    const capability = buildMemoryCapability({});
    const promptBuilder = capability.promptBuilder;
    expect(promptBuilder).toBeTypeOf("function");

    const withoutTools = promptBuilder!({
      availableTools: new Set(),
    });
    expect(withoutTools).toEqual([]);

    const withMemoryTools = promptBuilder!({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(withMemoryTools.length).toBeGreaterThan(0);
  });

  it("flushPlanResolver returns defaults and null when disabled", () => {
    const capability = buildMemoryCapability({});
    const flushPlanResolver = capability.flushPlanResolver;
    expect(flushPlanResolver).toBeTypeOf("function");

    const defaults = flushPlanResolver!({
      cfg: {},
      nowMs: Date.UTC(2026, 0, 2, 12, 0, 0),
    });

    expect(defaults).not.toBeNull();
    expect(defaults?.softThresholdTokens).toBe(4000);
    expect(defaults?.reserveTokensFloor).toBe(20_000);
    expect(defaults?.forceFlushTranscriptBytes).toBe(2 * 1024 * 1024);
    expect(defaults?.relativePath).toBe("memory/2026-01-02.md");
    expect(defaults?.prompt.length).toBeGreaterThan(0);
    expect(defaults?.systemPrompt.length).toBeGreaterThan(0);

    const disabled = flushPlanResolver!({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                enabled: false,
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 0, 2, 12, 0, 0),
    });

    expect(disabled).toBeNull();
  });
});
