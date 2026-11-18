import fs from "node:fs";

const envFile = new URL("../.env", import.meta.url);
const env = fs.existsSync(envFile)
  ? Object.fromEntries(
      fs
        .readFileSync(envFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
    )
  : {};

// Lo guardado desde Ajustes tiene prioridad sobre .env, igual que en el servidor.
const settingsFile = new URL("../data/ai-settings.json", import.meta.url);
const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null;

const baseUrl = (saved?.baseUrl || env.NOVACUT_AI_BASE_URL || "").replace(/\/+$/, "");
const key = saved?.apiKey || env.NOVACUT_AI_API_KEY || "";
const savedModel = saved?.model || env.NOVACUT_AI_MODEL || "";
const extraModels = (process.env.NOVACUT_AI_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const candidates = process.argv.slice(2).length
  ? process.argv.slice(2)
  : extraModels.length
    ? extraModels
    : [savedModel || "openai/gpt-oss-20b", "nvidia/nemotron-3-super-120b-a12b", "deepseek-ai/deepseek-v4.1-flash"];

if (!baseUrl || !key) {
  console.log("No hay proveedor configurado. Usa Ajustes → Proveedor de IA o crea .env con NOVACUT_AI_BASE_URL y NOVACUT_AI_API_KEY.");
  process.exit(1);
}

console.log(`Proveedor: ${new URL(baseUrl).host} · modelos: ${candidates.join(", ")}`);

for (const model of candidates) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: 'Responde solo JSON valido con la forma {"ok":true,"tool":"noop"}.' },
          { role: "user", content: "Confirma que puedes responder JSON." },
        ],
      }),
    });
    const text = await response.text();
    const ms = Date.now() - started;
    if (!response.ok) {
      console.log(`${model} -> HTTP ${response.status} (${ms} ms): ${text.slice(0, 200)}`);
      continue;
    }
    const payload = JSON.parse(text);
    const content = payload.choices?.[0]?.message?.content ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
    } catch {
      parsed = null;
    }
    console.log(
      `${model} -> OK (${ms} ms) jsonMode=${parsed ? "yes" : "no"} content=${JSON.stringify(content).slice(0, 120)} usage=${JSON.stringify(payload.usage ?? {})}`,
    );
  } catch (error) {
    console.log(`${model} -> FAIL ${error.message}`);
  }
}
