import { describe, expect, it } from "bun:test";

import { cacheSignature } from "../cache";
import { transformClaudeRequest } from "./claude";
import { transformGeminiRequest } from "./gemini";
import type { ModelFamily, RequestPayload, TransformContext } from "./types";

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

const VALID_CLAUDE_SIGNATURE = "RXJRQ0NrZ0lDaEFDR0FJcVFKdmIzVzdUKzcyNE9nS29LTVdocXpIOEVuZFB3VzltelFLZENYT2xTMWs5dXF3RUdNcTMzTEJuaW1keTdBUjhGSUVyVG1IMnk2SVQvYjJaMTFnL3pPRVNES2NoYmVWZzk1LzBMaE50dGhvTUJWUFVJRmxNZU5qSzJzNERJakJXdFhJeVg0ZUJBZ1p4Zk9hYkNBWER6SHRvb2ZtMVQ2SjZodWdwbXFzSHllR3RjeERLd2JicWJJUzRvQStzTm9jcW1RR0MyTUFKUmNBSXRMc3drSFNNK09DcWhPNWZlNWxtNERIN0pJdnluamFBcEVrMUtsZithWjBwZWgyb1ZrZlUyQmVwZVByc3k3UWJVcWFmc3dBSVl6QkNlY1BISTA4bmpneUlBT";

function createContext(model: string): TransformContext {
  const family: ModelFamily = model.includes("claude") ? "claude" : "gemini";
  return {
    model,
    family,
    projectId: "test-project",
    streaming: true,
    requestId: "test-request-id",
    sessionId: "test-session-id",
  };
}

describe("thoughtSignature handling", () => {
  describe("gemini transformer", () => {
    it("removes thinking blocks from model turns for Gemini", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
          {
            role: "model",
            parts: [
              {
                text: "I am thinking...",
                thought: true,
                thoughtSignature: VALID_CLAUDE_SIGNATURE,
              },
              { text: "Here is my response" },
            ],
          },
        ],
      };

      const context = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeUndefined();
      expect(modelParts.length).toBe(1);
      expect(modelParts[0].text).toBe("Here is my response");
    });

    it("applies bypass to functionCall parts", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Search for something" }],
          },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "google_search",
                  args: { query: "test" },
                },
              },
            ],
          },
        ],
      };

      const context = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const functionCallPart = modelParts.find((p: any) => p.functionCall);

      expect(functionCallPart.thoughtSignature).toBe(THOUGHT_SIGNATURE_BYPASS);
    });

    it("does not modify user role parts", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello", thoughtSignature: "user-sig-should-stay" }],
          },
        ],
      };

      const context = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const userParts = contents[0].parts;
      expect(userParts[0].thoughtSignature).toBe("user-sig-should-stay");
    });
  });

  describe("claude transformer", () => {
    it("keeps thinking blocks with valid signatures (length > 50)", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
          {
            role: "model",
            parts: [
              {
                text: "I am thinking...",
                thought: true,
                thoughtSignature: VALID_CLAUDE_SIGNATURE,
              },
              { text: "Here is my response" },
            ],
          },
        ],
      };

      const context = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeDefined();
      expect(thoughtPart.thoughtSignature).toBe(VALID_CLAUDE_SIGNATURE);
    });

    it("removes thinking blocks with invalid/short signatures", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
          {
            role: "model",
            parts: [
              {
                text: "This is unique thinking text that has never been cached before xyz123",
                thought: true,
                thoughtSignature: "short-invalid-sig",
              },
              { text: "Here is my response" },
            ],
          },
        ],
      };

      const context = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeUndefined();
      expect(modelParts.length).toBe(1);
      expect(modelParts[0].text).toBe("Here is my response");
    });

    it("keeps functionCall parts regardless of signature", () => {
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Search for something" }],
          },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "google_search",
                  args: { query: "test" },
                },
                thoughtSignature: "some-signature",
              },
            ],
          },
        ],
      };

      const context = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const functionCallPart = modelParts.find((p: any) => p.functionCall);

      expect(functionCallPart).toBeDefined();
      expect(functionCallPart.functionCall.name).toBe("google_search");
    });
  });

  describe("cross-model scenarios with cache", () => {
    it("Claude→Gemini: caches signature and removes thinking blocks", () => {
      const thinkingText = "The user is asking a simple arithmetic question...";
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: VALID_CLAUDE_SIGNATURE,
              },
              { text: "2 + 2 = 4" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "What about 3+3?" }],
          },
        ],
      };

      const context = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeUndefined();
      expect(modelParts.length).toBe(1);
      expect(modelParts[0].text).toBe("2 + 2 = 4");
    });

    it("Claude→Gemini→Claude: family-independent cache prevents cross-contamination", () => {
      const thinkingText = "The user is asking a simple arithmetic question...";
      
      const claudePayload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: VALID_CLAUDE_SIGNATURE,
              },
              { text: "2 + 2 = 4" },
            ],
          },
        ],
      };

      const geminiContext = createContext("gemini-3-pro-high");
      transformGeminiRequest(geminiContext, claudePayload);

      const geminiToClaudePayload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: THOUGHT_SIGNATURE_BYPASS,
              },
              { text: "2 + 2 = 4" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "What about 3+3?" }],
          },
        ],
      };

      const claudeContext = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(claudeContext, geminiToClaudePayload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeUndefined();
      expect(modelParts.length).toBe(1);
      expect(modelParts[0].text).toBe("2 + 2 = 4");
    });

    it("Claude→Claude: restores signature from same-family cache", () => {
      const thinkingText = "Same family thinking restoration test...";
      
      const firstClaudePayload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: VALID_CLAUDE_SIGNATURE,
              },
              { text: "2 + 2 = 4" },
            ],
          },
        ],
      };

      const claudeContext1 = createContext("claude-opus-4-5-thinking");
      transformClaudeRequest(claudeContext1, firstClaudePayload);

      const secondClaudePayload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: "short-sig",
              },
              { text: "2 + 2 = 4" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "What about 3+3?" }],
          },
        ],
      };

      const claudeContext2 = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(claudeContext2, secondClaudePayload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeDefined();
      expect(thoughtPart.thoughtSignature).toBe(VALID_CLAUDE_SIGNATURE);
    });

    it("Gemini→Claude: removes thinking blocks without cached signature", () => {
      const geminiOnlySignature = "GEMINI_SPECIFIC_SIG_not_in_cache_xyz";
      
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: "Gemini thinking that was never cached...",
                thought: true,
                thoughtSignature: geminiOnlySignature,
              },
              { text: "2 + 2 = 4" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "What about 3+3?" }],
          },
        ],
      };

      const context = createContext("claude-opus-4-5-thinking");
      const result = transformClaudeRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeUndefined();
      expect(modelParts.length).toBe(1);
      expect(modelParts[0].text).toBe("2 + 2 = 4");
    });

    it("Gemini→Gemini: restores signature from same-family cache", () => {
      const thinkingText = "Gemini thinking that should be restored...";
      const VALID_GEMINI_SIGNATURE = "GeminiValidSignatureXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      
      cacheSignature("gemini", "test-session-id", thinkingText, VALID_GEMINI_SIGNATURE);

      const geminiPayload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: "short-sig",
              },
              { text: "2 + 2 = 4" },
            ],
          },
          {
            role: "user",
            parts: [{ text: "What about 3+3?" }],
          },
        ],
      };

      const geminiContext = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(geminiContext, geminiPayload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeDefined();
      expect(thoughtPart.thoughtSignature).toBe(VALID_GEMINI_SIGNATURE);
    });

    it("Gemini keeps own thinking when pre-cached (simulates response caching)", () => {
      const thinkingText = "Gemini's own thinking...";
      const VALID_GEMINI_SIGNATURE = "GeminiValidSignatureYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";
      
      cacheSignature("gemini", "test-session-id", thinkingText, VALID_GEMINI_SIGNATURE);
      
      const payload: RequestPayload = {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is 2+2?" }],
          },
          {
            role: "model",
            parts: [
              {
                text: thinkingText,
                thought: true,
                thoughtSignature: VALID_GEMINI_SIGNATURE,
              },
              { text: "2 + 2 = 4" },
            ],
          },
        ],
      };

      const context = createContext("gemini-3-pro-high");
      const result = transformGeminiRequest(context, payload);
      const parsed = JSON.parse(result.body);
      const contents = parsed.request.contents;

      const modelParts = contents[1].parts;
      const thoughtPart = modelParts.find((p: any) => p.thought === true);

      expect(thoughtPart).toBeDefined();
      expect(thoughtPart.thoughtSignature).toBe(VALID_GEMINI_SIGNATURE);
      expect(modelParts.length).toBe(2);
    });
  });
});
