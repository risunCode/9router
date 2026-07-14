/**
 * Cursor CLI (Agent API) provider registry entry.
 *
 * Separate from the existing Cursor IDE provider (`cursor`/`cu`), which
 * uses `ChatService/StreamUnifiedChatWithTools`. Cursor CLI uses the
 * OMP-compatible Cursor Agent API at `AgentService/Run` with OAuth PKCE.
 */

export default {
  id: "cursor-cli",
  priority: 50,
  alias: "cursor-cli",
  uiAlias: "cursor-cli",
  display: {
    name: "Cursor CLI",
    icon: "terminal",
    color: "#00D4AA",
    website: "https://cursor.com",
    notice: {
      signupUrl: "https://cursor.com",
      description: "Cursor CLI — Agent API with OAuth login",
    },
  },
  category: "oauth",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  hidden: false,
  transport: {
    baseUrl: "https://api2.cursor.sh",
    chatPath: "/agent.v1.AgentService/Run",
    format: "cursor",
    forceStream: true,
    headers: {
      "connect-accept-encoding": "gzip",
      "connect-protocol-version": "1",
      "Content-Type": "application/connect+proto",
      "x-cursor-client-type": "cli",
    },
    clientVersion: "cli-2026.01.09-231024f",
  },
  models: [
    { id: "default", name: "Auto (Server Picks)" },
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "composer-2", name: "Composer 2" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "claude-4.6-opus-max", name: "Claude 4.6 Opus Max" },
    { id: "claude-4.6-sonnet-medium", name: "Claude 4.6 Sonnet Medium" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
  ],
  features: {
    usage: false,
  },
  oauth: {
    apiEndpoint: "https://api2.cursor.sh",
    chatEndpoint: "/agent.v1.AgentService/Run",
    modelsEndpoint: "/agent.v1.AgentService/GetUsableModels",
    clientVersion: "cli-2026.01.09-231024f",
    clientType: "cli",
    authMethod: "pkce",
    loginUrl: "https://cursor.com/loginDeepControl",
    pollUrl: "https://api2.cursor.sh/auth/poll",
    refreshUrl: "https://api2.cursor.sh/auth/exchange_user_api_key",
    dbKeys: {
      accessToken: "cursorCliAuth/accessToken",
      refreshToken: "cursorCliAuth/refreshToken",
    },
  },
};
