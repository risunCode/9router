import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { DEVIN_CHAT_PATH, fetchDevinAuthMetadata } from "./devin/protocol.js";
import { buildDevinRequest, DEVIN_MODEL_ID } from "./devin/request.js";
import { createDevinSseResponse } from "./devin/response.js";
import { sanitizeDevinErrorMessage, toDevinFallbackError } from "./devin/errors.js";

function selectedToken(credentials) {
  return credentials?.apiKey ?? credentials?.accessToken ?? credentials?.providerSpecificData?.apiKey ?? "";
}

export class DevinExecutor extends BaseExecutor {
  constructor() {
    super("devin", PROVIDERS.devin);
  }

  async execute({ model, body, credentials, signal, proxyOptions = null }) {
    if (model !== DEVIN_MODEL_ID) {
      throw Object.assign(new Error(`Unsupported Devin model: ${model}`), { status: 400, clientError: true, retryable: false });
    }
    const auth = await fetchDevinAuthMetadata({ token: selectedToken(credentials), baseUrl: this.config.baseUrl, signal, proxyOptions });
    const built = await buildDevinRequest({ model, body, apiKey: auth.apiKey, userJwt: auth.userJwt, signal });
    const url = `${auth.baseUrl}${DEVIN_CHAT_PATH}`;
    const headers = {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-content-encoding": "gzip",
      "connect-accept-encoding": "gzip",
      "accept-encoding": "identity",
      "user-agent": "connect-go/1.18.1",
    };
    const response = await proxyAwareFetch(url, { method: "POST", headers, body: built.frame, signal }, proxyOptions);
    if (!response.ok) {
      const raw = sanitizeDevinErrorMessage(await response.text());
      const failure = toDevinFallbackError({ status: response.status, message: raw });
      return {
        response: new Response(JSON.stringify({ error: { message: failure.message || `Devin upstream error ${response.status}`, type: failure.category, code: failure.category } }), { status: failure.clientError ? 400 : response.status, headers: { "content-type": "application/json" } }),
        url,
        headers,
        transformedBody: built.request,
      };
    }
    return { response: createDevinSseResponse(response, model), url, headers, transformedBody: built.request };
  }
}
