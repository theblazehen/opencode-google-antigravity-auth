import { createHash } from "node:crypto";
import { accessTokenExpired } from "./auth";
import type { OAuthAuthDetails } from "./types";

const authCache = new Map<string, OAuthAuthDetails>();

/**
 * Produces a stable cache key from a refresh token string.
 */
function normalizeRefreshKey(refresh?: string): string | undefined {
  const key = refresh?.trim();
  return key ? key : undefined;
}

/**
 * Returns a cached auth snapshot when available, favoring unexpired tokens.
 */
export function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return auth;
  }

  const cached = authCache.get(key);
  if (!cached) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(auth)) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(cached)) {
    return cached;
  }

  authCache.set(key, auth);
  return auth;
}

/**
 * Stores the latest auth snapshot keyed by refresh token.
 */
export function storeCachedAuth(auth: OAuthAuthDetails): void {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}

/**
 * Clears cached auth globally or for a specific refresh token.
 */
export function clearCachedAuth(refresh?: string): void {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}

// --- Thinking Signature Cache ---

const signatureCache = new Map<string, string>();

/**
 * Generates a SHA-256 hash key for a thought block.
 * We hash (sessionId + ":" + thoughtText) to ensure uniqueness and constant key size.
 */
function getSignatureKey(sessionId: string, thoughtText: string): string {
  const input = `${sessionId}:${thoughtText}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Caches a thought signature for a given session and thought text.
 * Implements a simple LRU-like eviction policy (clears old entries when limit reached).
 */
export function cacheSignature(sessionId: string, thoughtText: string, signature: string): void {
  const key = getSignatureKey(sessionId, thoughtText);
  signatureCache.set(key, signature);
}

/**
 * Retrieves a cached thought signature.
 */
export function getCachedSignature(sessionId: string, thoughtText: string): string | undefined {
  const key = getSignatureKey(sessionId, thoughtText);
  return signatureCache.get(key);
}
