import fs from "node:fs";
import path from "node:path";

export function normalizeM3u8InPlace(playlistPath) {
  const dir = path.dirname(playlistPath);
  const prefix = dir.replace(/\\/g, "/") + "/";

  let txt = fs.readFileSync(playlistPath, "utf8");

  // Remove prefix absoluto do próprio diretório do playlist
  // Ex: C:/CineSuper/hls/.../video/1080p/chunk_00001.m4s -> chunk_00001.m4s
  txt = txt.replaceAll(prefix, "");

  // Também remove com backslashes (caso raro)
  const prefixWin = dir + path.sep;
  txt = txt.replaceAll(prefixWin, "");

  fs.writeFileSync(playlistPath, txt, "utf8");
}
