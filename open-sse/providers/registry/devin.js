/**
 * Devin (Codeium Cascade) provider registry entry.
 *
 * The user supplies a single Devin session token per 9router connection —
 * the token is exchanged for a short-lived user JWT and a protobuf/Connect
 * chat request at runtime. The executor layer (open-sse/executors/devin/*)
 * owns the protocol; this file only advertises identity, transport defaults,
 * and the static `swe-1-6-slow` model that is verified to work on Free tier.
 *
 * Categories:
 *   - `apikey`            — credential is a single opaque session token.
 *   - `forceStream: true` — upstream always streams; 9router still assembles
 *                            non-streaming client responses from the stream
 *                            through the existing non-streaming handler.
 *   - `transport.format`  — not set: the executor bypasses the OpenAI/Claude
 *                            transport layer entirely (Devin uses Connect+proto).
 */

export default {
  id: "devin",
  priority: 50,
  alias: "devin",
  uiAlias: "devin",
  display: {
    name: "Devin",
    icon: "/providers/devin.png",
    color: "#0F2B5B",
    textIcon: "DV",
    website: "https://devin.ai",
    notice: {
      apiKeyUrl: "https://devin.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasOAuth: false,
  hidden: false,
  transport: {
    baseUrl: "https://server.codeium.com",
    // The executor manages its own protobuf framing; default OpenAI format
    // is intentionally omitted so the transport pipeline leaves the body alone.
    forceStream: true,
    headers: {
      "connect-accept-encoding": "gzip",
      "connect-protocol-version": "1",
      "Content-Type": "application/connect+proto",
    },
  },
  models: [
    {
      id: "swe-1-6-slow",
      name: "SWE-1.6 Slow",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  ],
  features: {
    usage: false,
  },
};
