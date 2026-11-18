import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiUrl = (process.env.NOVACUT_API_URL?.trim() || `http://127.0.0.1:${process.env.NOVACUT_PORT?.trim() || "4331"}`).replace(/\/+$/, "");
const mcpUrl = process.env.NOVACUT_MCP_URL?.trim() || `${apiUrl}/mcp`;
const token = process.env.NOVACUT_MCP_TOKEN?.trim();

const stdio = {
  mcpServers: {
    oeclip: {
      command: process.execPath,
      args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "server", "mcp", "stdio.ts")],
      cwd: root,
      env: {
        NOVACUT_API_URL: apiUrl,
        ...(token ? { NOVACUT_MCP_TOKEN: token } : {}),
      },
    },
  },
};

if (process.argv.includes("--http")) {
  console.log(
    JSON.stringify(
      {
        url: mcpUrl,
        auth: token ? "Authorization: Bearer <NOVACUT_MCP_TOKEN>" : "none (solo loopback)",
        claudeCode: `claude mcp add --transport http oeclip ${mcpUrl}${token ? " --header \"Authorization: Bearer <token>\"" : ""}`,
        geminiCli: { mcpServers: { oeclip: { httpUrl: mcpUrl, ...(token ? { headers: { Authorization: "Bearer <token>" } } : {}) } } },
        chatgpt: "Connector remoto: necesita una URL HTTPS pública (cloudflared/ngrok) hacia esta misma ruta y un token si lo configuras.",
        note: "La app (npm start) debe estar en marcha. Este endpoint ya está incluido en el servidor principal.",
      },
      null,
      2,
    ),
  );
} else {
  console.log(JSON.stringify(stdio, null, 2));
}
