import { startLiveUpload, uploadDirectoryRecursive } from "./uploadService.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import fs from "node:fs/promises";

import { getGenericStream } from "./httpStream.js";
import { probeAndReplayFromReadable } from "./probeStream.js";
import { buildOutputRoot, ensureTree } from "./paths.js";
import { normalizeM3u8InPlace } from "./playlists.js";
import { writeMaster } from "./master.js";

/* =========================
   Helpers
========================= */

function parseFps(rateStr) {
  if (!rateStr || typeof rateStr !== "string") return null;
  const [a, b] = rateStr.split("/").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : null;
}

function getVideoStreamFromProbe(probe) {
  const streams = probe?.streams || [];
  return streams.find((s) => s.codec_type === "video") || streams[0] || null;
}

function getVideoFpsFromProbe(probe) {
  const v = getVideoStreamFromProbe(probe);
  const fps = parseFps(v?.avg_frame_rate) || parseFps(v?.r_frame_rate) || null;
  return fps && fps > 0 ? fps : 30;
}

function clampInt(n, min, max) {
  const x = Math.round(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function normalizeExitCode(exitCode) {
  return exitCode > 255 ? exitCode - 4294967296 : exitCode;
}

function ensurePrefix(p) {
  let s = String(p || "").trim();
  s = s.replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");
  if (s && !s.endsWith("/")) s += "/";
  return s;
}

/* =========================
   Supabase r2-ingest caller (NOVO)
========================= */

async function callR2Ingest({ r2Prefix, r2PublicBase, has4k }) {
  const url = String(process.env.SUPA_R2_INGEST_URL || "").trim();
  const key = String(process.env.SUPA_INGEST_KEY || "").trim();

  if (!url) throw new Error("Missing env SUPA_R2_INGEST_URL (URL da Edge Function r2-ingest).");
  if (!key) throw new Error("Missing env SUPA_INGEST_KEY (x-ingest-key).");

  const body = {
    r2_prefix: ensurePrefix(r2Prefix),
    r2_public_base: String(r2PublicBase || "").trim(),
    has_4k: !!has4k,
  };

  if (!body.r2_prefix) throw new Error("callR2Ingest: r2_prefix vazio.");
  if (!body.r2_public_base) throw new Error("callR2Ingest: r2_public_base vazio (R2_PUBLIC_BASE).");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-key": key,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    throw new Error(`r2-ingest falhou: HTTP ${res.status} | ${JSON.stringify(json)}`);
  }

  return json;
}

/* =========================
   Renditions & bitrates
========================= */

function bitrateForKey(key) {
  if (key === "1080p") return "8000k";
  if (key === "2160p") return "15000k";
  return "8000k";
}

function bitrateKbpsFromString(br) {
  const n = parseInt(String(br).replace(/k$/i, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 4500;
}

function selectRenditions1080AndMaybe4k({ srcW }) {
  const br1080 = bitrateForKey("1080p");
  const renditions = [{ key: "1080p", scaleW: 1920, bitrateKbps: bitrateKbpsFromString(br1080) }];

  const isReal4k = srcW >= 3000;
  if (isReal4k) {
    const br4k = bitrateForKey("2160p");
    renditions.push({ key: "2160p", scaleW: 3840, bitrateKbps: bitrateKbpsFromString(br4k) });
  }

  return { renditions, isReal4k };
}

/* =========================
   Filters
========================= */

function buildFilterComplex(renditions, thumbsEvery, workFps) {
  const splitCount = renditions.length;
  const splitLabels = renditions.map((_, i) => `[v${i}]`).join("");
  const fpsFilter = workFps ? `,fps=${workFps}` : "";

  const parts = [`[0:v]format=yuv420p,setpts=PTS-STARTPTS${fpsFilter},split=${splitCount + 1}${splitLabels}[vthumb]`];

  renditions.forEach((r, i) => {
    parts.push(`[v${i}]scale=${r.scaleW}:-2:flags=bilinear[vs${i}]`);
  });

  parts.push(`[vthumb]fps=1/${thumbsEvery},scale=320:-1:flags=lanczos[thumbs]`);
  return parts.join(";");
}

/* =========================
   RC helpers
========================= */

function kToInt(brK) {
  return parseInt(String(brK).replace(/k$/i, ""), 10);
}
function intToK(n) {
  return `${Math.max(1, Math.round(n))}k`;
}
function maxrateForBitrate(brK, factor = 1.5) {
  const n = kToInt(brK);
  return intToK(n * factor);
}
function bufsizeForMaxrate(maxK, factor = 2) {
  const n = kToInt(maxK);
  return intToK(n * factor);
}

async function getSubEncodingArgs(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return [];
  } catch {
    console.log(`[Smart Subtitles] Encoding ANSI detectado: ${path.basename(filePath)}`);
    return ["-sub_charenc", "Windows-1252"];
  }
}

async function generateThumbsVTT(outRoot, duration, thumbsEvery) {
  const vttPath = path.join(outRoot, "thumbs", "thumbnails.vtt");
  let content = "WEBVTT\n\n";

  const totalThumbs = Math.ceil(duration / thumbsEvery);
  for (let i = 0; i < totalThumbs; i++) {
    const startTime = i * thumbsEvery;
    const endTime = (i + 1) * thumbsEvery;

    const start = new Date(startTime * 1000).toISOString().substr(11, 12);
    const end = new Date(endTime * 1000).toISOString().substr(11, 12);

    const indexStr = String(i + 1).padStart(5, "0");
    const filename = `thumb_${indexStr}.jpg`;

    content += `${start} --> ${end}\n${filename}\n\n`;
  }

  await fs.writeFile(vttPath, content);
  return vttPath;
}

/* =========================
   MAIN
========================= */

export async function runTranscodeJob({
  r2DestFolder,
  ffmpegPath,
  ffprobePath,
  baseRoot,
  url,
  headers,
  meta,
  selectedAudios,
  selectedSubs,
  externalSubs,
  hlsTime = 15,
  thumbsEvery = 10,
  onEvent,
}) {
  const outRoot = buildOutputRoot(baseRoot, meta);
  await ensureTree(outRoot, []);
  await mkdir(path.join(outRoot, "thumbs"), { recursive: true });
  await mkdir(path.join(outRoot, "subs"), { recursive: true });

  onEvent?.({ kind: "info", msg: `Saída Local: ${outRoot}` });

  // ✅ Começa upload “ao vivo”
  const uploadWatcher = startLiveUpload(outRoot, r2DestFolder);

  // Probe
  const resProbe = await getGenericStream(url, { headers });
  const { probe, replayStream } = await probeAndReplayFromReadable({
    inputReadable: resProbe,
    ffprobePath,
    onLog: (m) => onEvent?.({ kind: "log", step: "probe", line: m }),
  });
  try {
    resProbe.destroy();
  } catch {}

  const vStream = getVideoStreamFromProbe(probe);
  const srcW = Number(vStream?.width || probe?.width || 0);
  const srcH = Number(vStream?.height || probe?.height || 0);

  let rawDuration = probe.format?.duration || vStream?.duration || probe.streams?.[0]?.duration || 0;
  const duration = parseFloat(rawDuration);

  const fpsIn = getVideoFpsFromProbe(probe);
  const workFps = fpsIn > 31 ? 30 : null;

  const { renditions, isReal4k } = selectRenditions1080AndMaybe4k({ srcW });

  // ✅ define “has_4k” de forma inequívoca (baseado na saída gerada)
  const has4k = renditions.some((r) => r.key === "2160p") && isReal4k;

  onEvent?.({
    kind: "info",
    msg: `Fonte: ${srcW}x${srcH} | 4K_real=${isReal4k ? "sim" : "não"} | Saídas: ${renditions.map((r) => r.key).join(" + ")}`,
  });

  const filterComplex = buildFilterComplex(renditions, thumbsEvery, workFps);

  const fpsForGop = workFps || fpsIn;
  const gop = clampInt(fpsForGop * hlsTime, 24, 600);
  const forceExpr = `expr:gte(t,n_forced*${hlsTime})`;

  // Inputs
  const args = ["-y"];
  args.push("-i", "pipe:0");

  let inputIdx = 1;
  if (externalSubs) {
    for (const ext of externalSubs) {
      const absPath = path.resolve(ext.path);
      const encodingArgs = await getSubEncodingArgs(absPath);
      args.push(...encodingArgs, "-i", absPath);
      ext.inputIndex = inputIdx;
      inputIdx++;
    }
  }

  args.push("-filter_complex", filterComplex);

  // Vídeo
  for (const [i, r] of renditions.entries()) {
    const outDir = path.join(outRoot, "video", r.key);
    await mkdir(outDir, { recursive: true });

    const br = bitrateForKey(r.key);
    const max = maxrateForBitrate(br, 1.5);
    const buf = bufsizeForMaxrate(max, 2);

    args.push(
      "-map",
      `[vs${i}]`,
      "-an",
      "-sn",

      "-c:v",
      "h264_amf",
      "-usage",
      "transcoding",
      "-quality",
      "balanced",
      "-profile:v",
      "main",

      "-rc",
      "vbr_peak",
      "-async_depth",
      "2",

      "-bf",
      "0",
      "-max_b_frames",
      "0",

      "-b:v",
      br,
      "-maxrate",
      max,
      "-bufsize",
      buf,

      "-pix_fmt",
      "yuv420p",

      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
      "-force_key_frames",
      forceExpr,

      "-max_muxing_queue_size",
      "9999",

      "-f",
      "hls",
      "-hls_time",
      String(hlsTime),
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      path.join(outDir, "init.mp4"),
      "-hls_segment_filename",
      path.join(outDir, "chunk_%05d.m4s"),
      path.join(outDir, "index.m3u8")
    );
  }

  // Áudio
  for (const a of selectedAudios) {
    const outDir = path.join(outRoot, `audio-${a.lang}`);
    await mkdir(outDir, { recursive: true });

    args.push(
      "-map",
      `0:${a.aIndex}`,
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-f",
      "hls",
      "-hls_time",
      String(hlsTime),
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      path.join(outDir, "init.mp4"),
      "-hls_segment_filename",
      path.join(outDir, "chunk_%05d.m4s"),
      path.join(outDir, "index.m3u8")
    );
  }

  const allSubsForMaster = [];

  // Legendas
  if (selectedSubs) {
    for (const s of selectedSubs) {
      const outDir = path.join(outRoot, "subs");
      const subName = `subs-${s.lang}-int`;
      args.push(
        "-map",
        `0:${s.sIndex}`,
        "-c:s",
        "webvtt",
        "-f",
        "segment",
        "-segment_time",
        "600",
        "-segment_list",
        path.join(outDir, `${subName}.m3u8`),
        "-segment_list_type",
        "m3u8",
        "-segment_format",
        "webvtt",
        path.join(outDir, `${subName}_%03d.vtt`)
      );
      allSubsForMaster.push({ lang: s.lang, name: s.name, uri: `subs/${subName}.m3u8` });
    }
  }

  if (externalSubs) {
    for (const ext of externalSubs) {
      const outDir = path.join(outRoot, "subs");
      const subName = `subs-${ext.lang}-ext`;
      args.push(
        "-map",
        `${ext.inputIndex}:0`,
        "-c:s",
        "webvtt",
        "-f",
        "segment",
        "-segment_time",
        "600",
        "-segment_list",
        path.join(outDir, `${subName}.m3u8`),
        "-segment_list_type",
        "m3u8",
        "-segment_format",
        "webvtt",
        path.join(outDir, `${subName}_%03d.vtt`)
      );
      allSubsForMaster.push({ lang: ext.lang, name: ext.name, uri: `subs/${subName}.m3u8` });
    }
  }

  // Thumbs
  args.push("-map", "[thumbs]", "-q:v", "3", path.join(outRoot, "thumbs", "thumb_%05d.jpg"));

  console.log("[Job] Iniciando conversão (modo estabilidade AMF)...");
  console.log(`[Debug] FFmpeg: ${ffmpegPath} ${args.join(" ")}`);

  let inputStream = null;
  try {
    inputStream = await getGenericStream(url, { headers });
  } catch {
    inputStream = replayStream;
  }

  const ff = spawn(ffmpegPath, args, { windowsHide: true });

  ff.stdin.on("error", () => {});
  ff.stderr.on("data", (chunk) => {
    const msg = chunk.toString();
    if (msg.toLowerCase().includes("error") || msg.includes("Invalid")) console.log(`[FFmpeg] ${msg}`);
    if (msg.includes("speed=")) onEvent?.({ kind: "log", step: "ffmpeg", line: msg });
  });

  inputStream.pipe(ff.stdin);
  inputStream.on("error", (e) => console.log(`[Stream Input Error] ${e.message}`));

  const exitCode = await new Promise((res, rej) => {
    ff.on("error", rej);
    ff.on("close", res);
  });
  if (normalizeExitCode(exitCode) !== 0) throw new Error(`FFmpeg falhou code=${exitCode}`);

  if (duration > 0) await generateThumbsVTT(outRoot, duration, thumbsEvery);

  for (const r of renditions) normalizeM3u8InPlace(path.join(outRoot, "video", r.key, "index.m3u8"));
  for (const a of selectedAudios) normalizeM3u8InPlace(path.join(outRoot, `audio-${a.lang}`, "index.m3u8"));
  for (const s of allSubsForMaster) normalizeM3u8InPlace(path.join(outRoot, s.uri));

  writeMaster(outRoot, renditions, selectedAudios, allSubsForMaster, "master.m3u8", null);
  writeMaster(outRoot, renditions, selectedAudios, allSubsForMaster, "master-hd.m3u8", 1080);

  console.log("[Job] Upload Final (re-upload completo)...");
  await uploadWatcher.close();
  await uploadDirectoryRecursive(outRoot, r2DestFolder);

  // ✅ AGORA: avisa o Supabase que o pacote existe no R2
  // (faz depois do upload final para garantir que master/master-hd já estão no R2)
  try {
    const r2PublicBase = String(process.env.R2_PUBLIC_BASE || "").trim();
    const r2Prefix = ensurePrefix(r2DestFolder);

    onEvent?.({
      kind: "info",
      msg: `Chamando r2-ingest: prefix="${r2Prefix}" has_4k=${has4k ? "true" : "false"}`,
    });

    const ingestRes = await callR2Ingest({ r2Prefix, r2PublicBase, has4k });

    onEvent?.({
      kind: "info",
      msg: `r2-ingest OK: ${JSON.stringify(ingestRes?.hls || ingestRes)}`,
    });
  } catch (e) {
    // Se você preferir NÃO falhar o job por causa do ingest, troque por "console.warn" e siga.
    // Eu deixei falhar, porque sem isso o catálogo não atualiza.
    throw new Error(`Falha ao chamar r2-ingest: ${e?.message || e}`);
  }

  try {
    await rm(outRoot, { recursive: true, force: true });
  } catch {}

  onEvent?.({ kind: "done", msg: "Sucesso Total.", outRoot });
  return { outRoot };
}
