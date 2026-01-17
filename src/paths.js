import path from "node:path";
import fs from "fs-extra";

function sanitize(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(n) {
  const v = Number(n || 0);
  return v < 10 ? `0${v}` : String(v);
}

/**
 * C:\CineSuper\hls\{GENERO}\{TIPO}\{NOME}\{Temporada XX}\{Episódio}
 *
 * TIPO: Filmes | Series
 */
export function buildOutputRoot(baseRoot, meta) {
  const genre = sanitize(meta.genre);
  const tipo = meta.type === "series" ? "Series" : "Filmes";
  const title = sanitize(meta.title);

  if (meta.type === "movie") {
    return path.join(baseRoot, genre, tipo, title);
  }

  const season = `Temporada ${pad2(meta.seasonNumber || 1)}`;
  const episode = sanitize(meta.episodeName || `E${pad2(meta.episodeNumber || 0)}`);
  return path.join(baseRoot, genre, tipo, title, season, episode);
}

export async function ensureTree(outRoot, audioLangs = []) {
  await fs.ensureDir(outRoot);
  await fs.ensureDir(path.join(outRoot, "video"));
  await fs.ensureDir(path.join(outRoot, "thumbs"));
  await fs.ensureDir(path.join(outRoot, "subs"));

  for (const lang of audioLangs) {
    await fs.ensureDir(path.join(outRoot, `audio-${lang}`));
  }
}
