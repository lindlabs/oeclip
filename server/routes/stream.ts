import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const startRaw = match[1];
  const endRaw = match[2];
  let start: number;
  let end: number;
  if (!startRaw && endRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw ?? 0);
    end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  options: {
    contentType: string;
    fileName: string;
    download?: boolean;
    cacheControl?: string;
    headers?: Record<string, string>;
  },
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    reply.code(404).send({ error: "El archivo no existe.", code: "file_not_found" });
    return;
  }
  if (!stat.isFile()) {
    reply.code(404).send({ error: "El archivo no existe.", code: "file_not_found" });
    return;
  }
  const range = parseRange(request.headers.range, stat.size);
  if (range === "invalid") {
    reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = end - start + 1;
  const disposition = options.download ? "attachment" : "inline";
  const encodedName = encodeURIComponent(options.fileName);
  const headers: Record<string, string> = {
    "Content-Type": options.contentType,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl ?? "private, max-age=3600",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
    ...options.headers,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  reply.hijack();
  reply.raw.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    reply.raw.end();
    return;
  }
  const stream = createReadStream(filePath, { start, end });
  try {
    await pipeline(stream, reply.raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ECONNRESET") {
      request.log.error({ err: error }, "stream error");
    }
    if (!reply.raw.writableEnded) reply.raw.destroy();
  }
}
