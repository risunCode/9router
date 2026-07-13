import { PROVIDER_MODELS } from "@/shared/constants/models";
import {
  filterModelCatalog,
  resolveModelsApiKeyPolicy,
} from "../../v1/models/route.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    const auth = await resolveModelsApiKeyPolicy(request);
    if (auth.response) return auth.response;
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }
    
    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    const policyModels = models.map((model) => {
      const modelId = model.name.slice("models/".length);
      return {
        ...model,
        id: modelId.startsWith("gemini/") ? modelId : `gemini/${modelId}`,
      };
    });
    const allowedNames = new Set(
      filterModelCatalog(policyModels, auth.policy).map((model) => model.name),
    );

    return Response.json({ models: models.filter((model) => allowedNames.has(model.name)) });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
