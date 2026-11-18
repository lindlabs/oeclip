const BASE = "http://127.0.0.1:4331/api";
const projectId = "prj_ea08344f6cdf406c";

async function request<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function main() {
  const project = await request<{ project: any }>(`/projects/${projectId}`);
  console.log("PROJECT", project.project.revision, "tracks", project.project.tracks.length);
  for (const t of project.project.tracks) {
    if (t.clips.length) console.log("  TRACK", t.name, t.clips.map(c => `${c.type}@${c.startFrame}/${c.durationFrames}`).join(" "));
  }

  // Pedir subtítulos en estilo neon
  const t0 = Date.now();
  const chat = await request(`/projects/${projectId}/motion/chat?currentFrame=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Pon subtítulos en estilo neon al vídeo",
    }),
  });
  console.log("CHAT", chat.responses.length, "responses,", Date.now() - t0, "ms");
  for (const r of chat.responses) {
    console.log("  RESP", r.type, r.data?.componentName ?? "", r.data?.style ?? "", (r.content ?? "").slice(0, 120));
  }

  const component = chat.responses.find(r => r.type === "component");
  const preview = chat.responses.find(r => r.type === "preview");
  console.log("PREVIEW", preview ? `${Math.round((preview.data?.base64Video ?? "").length / 1024)} KB` : "none");
  if (!component?.data?.renderKey) return;

  const key = component.data.renderKey;
  console.log("RENDER_KEY", key);
  let last = "";
  while (true) {
    const job = await request(`/projects/${projectId}/motion/render/${key}`);
    const line = `${job.status} ${Math.round(job.progress * 100)}% ${job.stage} eta=${job.etaMs ?? "-"}`;
    if (line !== last) {
      console.log("  POLL", line);
      last = line;
    }
    if (job.status !== "rendering") break;
    await new Promise(r => setTimeout(r, 700));
  }
  console.log("RENDER DONE");

  const tInsert = Date.now();
  const inserted = await request(`/projects/${projectId}/motion/insert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, startFrame: 0, currentFrame: 0 }),
  });
  console.log("INSERT", Date.now() - tInsert, "ms", JSON.stringify(inserted));

  const after = await request(`/projects/${projectId}`);
  console.log("AFTER rev", after.project.revision);
  for (const t of after.project.tracks) {
    if (t.clips.length) console.log("  TRACK", t.name, t.clips.map(c => `${c.type}@${c.startFrame}/${c.durationFrames} (${c.mediaId})`).join(" "));
  }
}

void main().catch(e => { console.error("FAIL", e); process.exit(1); });