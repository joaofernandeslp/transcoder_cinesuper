import fs from "node:fs";
import path from "node:path";

function audioLine(a, isDefault) {
  return `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${a.name}",LANGUAGE="${a.lang}",DEFAULT=${
    isDefault ? "YES" : "NO"
  },AUTOSELECT=YES,URI="audio-${a.lang}/index.m3u8"`;
}

function streamLine(r) {
  const res =
    r.key === "720p" ? "1280x720" :
    r.key === "1080p" ? "1920x1080" :
    r.key === "2160p" ? "3840x2160" : "";

  return `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},${res ? `RESOLUTION=${res},` : ""}AUDIO="aud"\nvideo/${r.key}/index.m3u8`;
}

export function writeMaster(outRoot, renditions, audios) {
  const masterPath = path.join(outRoot, "master.m3u8");
  const defaultAudio = audios.find((x) => x.lang === "pt") || audios[0];

  const content = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS

${audios.map((a) => audioLine(a, a.lang === defaultAudio.lang)).join("\n")}

${renditions.map(streamLine).join("\n\n")}
`;

  fs.writeFileSync(masterPath, content, "utf8");
  return masterPath;
}
