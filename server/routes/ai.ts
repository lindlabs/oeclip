import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../util/fs";
import { aiStatus, listRemoteModels, resetAiChatCircuit, testAiProvider } from "../ai/provider";
import { publicAiSettings, saveAiSettings } from "../ai/settings";

const saveSchema = z.object({
  provider: z.string().trim().min(1).max(40).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim().max(200).optional(),
  transcribeModel: z.string().trim().max(200).optional(),
  supportsTranscription: z.boolean().optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
});

const testSchema = z.object({
  provider: z.string().trim().max(40).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  transcribeModel: z.string().trim().max(200).optional(),
});

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ai/status", async () => aiStatus());

  app.get("/api/ai/settings", async () => publicAiSettings());

  app.put("/api/ai/settings", async (request) => {
    const body = saveSchema.parse(request.body ?? {});
    try {
      const saved = saveAiSettings(body);
      resetAiChatCircuit();
      return saved;
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof Error ? error.message : "No se pudo guardar la configuración de IA.",
        "ai_settings_invalid",
      );
    }
  });

  app.post("/api/ai/test", async (request) => {
    const body = testSchema.parse(request.body ?? {});
    const result = await testAiProvider(body);
    if (result.ok) resetAiChatCircuit();
    return result;
  });

  app.post("/api/ai/models", async (request) => {
    const body = testSchema.parse(request.body ?? {});
    return listRemoteModels(body);
  });
}
