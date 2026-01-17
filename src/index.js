import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import multer from "multer"; // <--- NOVO
import fs from "node:fs/promises"; // <--- NOVO (Para deletar o srt temp)

import { getGenericStream } from "./httpStream.js"; 
import { probeAndReplayFromReadable } from "./probeStream.js";
import { runTranscodeJob } from "./jobRunner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Configura upload temporário na pasta "uploads"
const upload = multer({ dest: "uploads/" });

const FFMPEG = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "C:\\ffmpeg\\bin\\ffprobe.exe";
const BASE_ROOT = "C:\\CineSuper\\hls";

const jobs = new Map();

function pushEvent(id, ev) {
  const j = jobs.get(id);
  if (!j) return;
  j.events.push(ev);
  for (const res of j.listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/probe-url", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url obrigatório" });
  try {
    const stream = await getGenericStream(url, {});
    const { probe } = await probeAndReplayFromReadable({ inputReadable: stream, ffprobePath: FFPROBE });
    stream.destroy(); 
    res.json({ probe });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// --- ROTA DE JOB COM UPLOAD ---
// upload.any() permite receber qualquer arquivo enviado pelo front
app.post("/api/jobs", upload.any(), async (req, res) => {
  try {
    // Como é FormData, tudo vem como string. Precisamos fazer o Parse.
    const url = req.body.url;
    const meta = JSON.parse(req.body.meta);
    const selectedAudios = JSON.parse(req.body.selectedAudios);
    // Legendas internas (do torrent)
    const selectedSubs = req.body.selectedSubs ? JSON.parse(req.body.selectedSubs) : [];

    // Processa Legendas EXTERNAS (Upload)
    const externalSubs = [];
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            // O front manda o campo com nome tipo "extSub_pt" ou "extSub_en"
            // Pegamos o idioma do nome do campo
            const lang = file.fieldname.split('_')[1] || 'und';
            externalSubs.push({
                path: file.path, // Caminho temporário do SRT
                lang: lang,
                name: lang === 'pt' ? 'Portugues (Ext)' : 'Ingles (Ext)'
            });
        });
    }

    // Lógica de Pastas R2
    const typeFolder = meta.type === 'serie' ? 'Séries' : 'Filmes';
    let r2Path = `${meta.genre}/${typeFolder}/${meta.title}`;
    if (meta.type === 'serie') {
        const s = String(meta.season || 1).padStart(2, '0');
        const e = String(meta.episode || 1).padStart(2, '0');
        r2Path += `/Temporada ${s}/Episodio ${e}`;
    }
  
    const id = nanoid(10);
    jobs.set(id, { events: [], listeners: [] });
    res.json({ id, target: r2Path });

    (async () => {
      try {
        pushEvent(id, { kind: "start", msg: "Job iniciado", id, target: r2Path });

        await runTranscodeJob({
          ffmpegPath: FFMPEG,
          ffprobePath: FFPROBE,
          baseRoot: BASE_ROOT,
          url,
          headers: {},
          meta,
          selectedAudios,
          selectedSubs,
          externalSubs, // <--- PASSANDO AS EXTERNAS
          r2DestFolder: r2Path,
          hlsTime: 15,
          thumbsEvery: 10,
          onEvent: (ev) => pushEvent(id, ev)
        });

        // Limpa arquivos temporários (.srt)
        for (const f of externalSubs) { try { await fs.unlink(f.path); } catch{} }

        pushEvent(id, { kind: "final", status: "done" });
      } catch (e) {
        console.error(e);
        pushEvent(id, { kind: "error", msg: String(e.message) });
      }
    })();

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro: " + err.message });
  }
});

app.get("/api/jobs/:id/events", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const ev of j.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  j.listeners.push(res);
  req.on("close", () => { j.listeners = j.listeners.filter((x) => x !== res); });
});

app.listen(5055, () => console.log("Server: http://localhost:5055"));