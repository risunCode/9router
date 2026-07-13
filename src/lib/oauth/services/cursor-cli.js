import { CURSOR_CLI_CONFIG } from "../constants/oauth.js";

/**
 * Cursor CLI OAuth Service
 *
 * PKCE Authorization Code Flow for Cursor CLI authentication.
 * The user logs in through Cursor.com and 9router polls for the access token.
 */

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

import { generatePKCE } from "../utils/pkce.js";
import { spinner as createSpinner } from "../utils/ui.js";
import open from "open";
import { OAUTH_TIMEOUT } from "../constants/oauth.js";

export class CursorCliService {
  constructor() {
    this.config = CURSOR_CLI_CONFIG;
  }

  /**
   * Generate Cursor CLI authorization parameters.
   * Returns the PKCE verifier, challenge, UUID, and a ready-to-open login URL.
   */
  async generateAuthParams() {
    const { verifier, challenge } = generatePKCE();
    const uuid = crypto.randomUUID();
    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: "login",
      redirectTarget: "cli",
    });
    const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
    return { verifier, challenge, uuid, loginUrl };
  }

  /**
   * Poll the Cursor authorization endpoint for completed login.
   * Returns { accessToken, refreshToken } on success.
   */
  async pollForToken(uuid, verifier) {
    let delay = POLL_BASE_DELAY_MS;
    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        const response = await fetch(
          `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
        );

        if (response.status === 404) {
          consecutiveErrors = 0;
          delay = Math.min(
            delay * POLL_BACKOFF_MULTIPLIER,
            POLL_MAX_DELAY_MS
          );
          continue;
        }

        if (response.ok) {
          const data = await response.json();
          if (!data.accessToken) {
            throw new Error("No access token in poll response");
          }
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || null,
          };
        }

        throw new Error(`Poll failed: HTTP ${response.status}`);
      } catch (err) {
        if (err.message?.startsWith("No access token")) throw err;
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error(
            "Too many consecutive errors during Cursor CLI auth polling"
          );
        }
      }
    }

    throw new Error("Cursor CLI authentication polling timeout");
  }

  /**
   * Refresh a Cursor CLI access token using the refresh or access token.
   */
  async refreshToken(token) {
    const response = await fetch(CURSOR_REFRESH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "unknown");
      throw new Error(`Cursor CLI token refresh failed: ${error}`);
    }

    const data = await response.json();
    const expiresAt = getTokenExpiry(data.accessToken);

    return {
      access: data.accessToken,
      refresh: data.refreshToken || token,
      expires: expiresAt,
    };
  }

  /**
   * Complete Cursor CLI OAuth flow interactively (dashboard-driven).
   */
  async authenticate(onAuthUrl) {
    const { verifier, uuid, loginUrl } = await this.generateAuthParams();

    if (onAuthUrl) {
      onAuthUrl(loginUrl);
    } else {
      console.log(`\nOpening browser for Cursor CLI authentication...`);
      console.log(`If browser doesn't open, visit:\n${loginUrl}\n`);
      await open(loginUrl);
    }

    const { accessToken, refreshToken } = await this.pollForToken(
      uuid,
      verifier
    );

    const expiresAt = getTokenExpiry(accessToken);

    return {
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }

  /**
   * Extract user info from a Cursor CLI JWT access token.
   */
  extractUserInfo(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;
      let payload = parts[1];
      while (payload.length % 4) payload += "=";
      const decoded = JSON.parse(
        Buffer.from(
          payload.replace(/-/g, "+").replace(/_/g, "/"),
          "base64"
        ).toString()
      );
      return {
        email: decoded.email || decoded.sub || null,
        userId: decoded.sub || decoded.user_id || null,
        expiresAt: decoded.exp ? decoded.exp * 1000 : null,
      };
    } catch {
      return null;
    }
  }
}

// ── Token expiry helpers ────────────────────────────────────────────────────

function getTokenExpiry(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return Date.now() + 3600 * 1000;
    let payload = parts[1];
    if (!payload) return Date.now() + 3600 * 1000;
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString()
    );
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.exp === "number"
    ) {
      return decoded.exp * 1000 - 5 * 60 * 1000; // 5-minute buffer
    }
  } catch {
    // Ignore parse failures
  }
  return Date.now() + 3600 * 1000;
}

export function isCursorCliTokenExpiringSoon(token, thresholdSeconds = 300) {
  try {
    const [, payload] = token.split(".");
    if (!payload) return true;
    let decodedPayload = payload;
    while (decodedPayload.length % 4) decodedPayload += "=";
    const decoded = JSON.parse(
      Buffer.from(
        decodedPayload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString()
    );
    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp - currentTime < thresholdSeconds;
  } catch {
    return true;
  }
}
