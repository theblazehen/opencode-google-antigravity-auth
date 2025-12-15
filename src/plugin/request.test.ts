import { expect, test, describe } from "bun:test";
import { prepareAntigravityRequest } from "./request";

describe("Interleaved Thinking Headers", () => {
  test("adds interleaved thinking header for claude thinking models", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });

  test("does NOT add header for non-thinking claude models", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.has("anthropic-beta")).toBe(false);
  });

  test("merges with existing anthropic-beta header", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    const existingHeaders = { "anthropic-beta": "prompt-caching-2024-07-31" };
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", headers: existingHeaders, body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31,interleaved-thinking-2025-05-14");
  });

  test("does not duplicate header if already present", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    const existingHeaders = { "anthropic-beta": "interleaved-thinking-2025-05-14" };
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", headers: existingHeaders, body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });
});
