import path from "node:path";
import fs from "fs-extra";
import ffmpeg from "fluent-ffmpeg";
import { buildOutRoot, ensureTree, audioDir } from "./paths.js";
import { renditionsByWidth } from "./detect.js";
import { writeMaster } from "./MasterPlaylist.js";

export class StreamTranscoder {
  constructor({
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    outputBaseDir = "C:\\CineSuper\\hls",
    hlsTime = 15,
    thumbsEvery = 10
  } = {}) {
    this.outputBaseDir = outputBaseDir;
    this.hlsTime = hlsTime;
    this.thumbsEvery = thumbsEvery;

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
  }

  async probeUrl(url, headers = {}) {
    return new Promise((resolve, reject) => {
      // fluent-ffmpeg ffprobe suporta URL
      ffmpeg.ffprobe(
        { source: url, headers },
        (err, data) => {
          if (err) return reject(err);

          const streams = Array.isArray(data.streams) ? data.streams : [];
          const v = streams.find((s) => s.codec_type === "video");
          const a = streams.filter((s) => s.codec_type === "audio");

          if (!v?.width) return reject(new Error("Não encontrei stream de vídeo (width) via ffprobe."));

          resolve({
            video: { width: Number(v.width), height: Number(v.height || 0), codec: v.codec_name },
            audios: a.map((x, pos) => ({
              aIndex: pos, // posição em 0:a:<pos>
              codec: x.codec_name,
              channels: x.channels || 2,
              language: String(x.tags?.language || "und").toLowerCase(),
              title: x.tags?.title || ""
            })),
            raw: data
          });
        }
      );
    });
  }

  /**
   * meta: { genre, type:"movie"|"series", title, seasonNumber?, episodeName? }
   * url: string
   * headers: opcional (signed URL normalmente não precisa)
   * selectedAudios: [{ aIndex, lang, name }]
   */
  async transcodeFromUrl({ url, headers = {}, meta, selectedAudios, onLog }) {
    if (!url) throw new Error("url obrigatório");
    if (!meta?.genre || !meta?.type || !meta?.title) throw new Error("meta incompleto (genre/type/title)");
    if (!Array.isArray(selectedAudios) || selectedAudios.length === 0) {
      throw new Error("selectedAudios obrigatório (selecione ao menos 1 faixa).");
    }

    // 1) Probe
    const info = await this.probeUrl(url, headers);
    onLog?.(`[probe] width=${info.video.width} height=${info.video.height} codec=${info.video.codec}`);

    // 2) Renditions por largura (anti-crop)
    const renditions = renditionsByWidth(info.video.width);

    // 3) Diretórios
    const outRoot = buildOutRoot(this.outputBaseDir, meta);
    await ensureTree(outRoot, selectedAudios.map((a) => a.lang));
    for (const r of renditions) await fs.ensureDir(path.join(outRoot, "video", r.key));

    // 4) Um único ffmpeg com múltiplas saídas
    const splitCount = renditions.length;
    const splitLabels = renditions.map((_, i) => `[v${i}]`).join("");
    const filterParts = [`[0:v]split=${splitCount}${splitLabels}`];

    renditions.forEach((r, i) => {
      filterParts.push(`[v${i}]scale=${r.scaleW}:-2:flags=lanczos[vs${i}]`);
    });

    // thumbs a cada 10s (fps=1/10)
    filterParts.push(`[0:v]fps=1/${this.thumbsEvery},scale=320:-2:flags=lanczos[thumbs]`);
    const complex = filterParts.join(";");

    const cmd = ffmpeg()
      .input(url)
      .inputOptions(this._headersInputOptions(headers))
      .complexFilter(complex);

    // 4.1) Vídeo (HLS fMP4) — sem áudio
    renditions.forEach((r, i) => {
      const outDir = path.join(outRoot, "video", r.key);

      // Importante: para garantir init.mp4 no lugar certo, use caminhos absolutos.
      const playlist = path.join(outDir, "index.m3u8");
      const initFile = path.join(outDir, "init.mp4");
      const segPat = path.join(outDir, "chunk_%05d.m4s");

      cmd.output(playlist).outputOptions([
        "-map", `[vs${i}]`,
        "-an",
        "-c:v", "libx264",
        "-profile:v", "main",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-keyint_min", "60",
        "-sc_threshold", "0",
        "-f", "hls",
        "-hls_time", String(this.hlsTime),
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", initFile,
        "-hls_segment_filename", segPat
      ]);
    });

    // 4.2) Áudios (HLS fMP4) — separados
    selectedAudios.forEach((a) => {
      const outDir = audioDir(outRoot, a.lang);
      const playlist = path.join(outDir, "index.m3u8");
      const initFile = path.join(outDir, "init.mp4");
      const segPat = path.join(outDir, "chunk_%05d.m4s");

      cmd.output(playlist).outputOptions([
        "-map", `0:a:${a.aIndex}`,
        "-vn",
        "-sn",
        "-dn",
        "-c:a", "aac",
        "-b:a", "160k",
        "-ac", "2",
        "-f", "hls",
        "-hls_time", String(this.hlsTime),
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", initFile,
        "-hls_segment_filename", segPat
      ]);
    });

    // 4.3) Thumbs
    const thumbsPat = path.join(outRoot, "thumbs", "thumb_%05d.jpg");
    cmd.output(thumbsPat).outputOptions([
      "-map", "[thumbs]",
      "-q:v", "4"
    ]);

    // 5) Rodar e tratar erros
    await new Promise((resolve, reject) => {
      cmd.on("start", (line) => onLog?.(`[ffmpeg] ${line}`));
      cmd.on("stderr", (line) => onLog?.(String(line)));

      cmd.on("error", (err, stdout, stderr) => {
        reject(new Error(`FFmpeg falhou: ${err?.message || err}\n${String(stderr || "").slice(0, 4000)}`));
      });

      cmd.on("end", resolve);
      cmd.run();
    });

    // 6) Master playlist final (audio-group)
    const masterPath = writeMaster(
      outRoot,
      renditions,
      selectedAudios.map((a) => ({ lang: a.lang, name: a.name }))
    );

    return { outRoot, masterPath, probe: info.video, renditions };
  }

  _headersInputOptions(headers) {
    // FFmpeg aceita headers via -headers "Key: Value\r\nKey2: Value2\r\n"
    const keys = Object.keys(headers || {});
    if (!keys.length) return [];
    const headerStr = keys.map((k) => `${k}: ${headers[k]}`).join("\r\n") + "\r\n";
    return ["-headers", headerStr];
  }
}
