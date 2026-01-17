export function renditionsByWidth(width) {
  const w = Number(width || 0);
  const r = [];

  // Regras pedidas:
  // >= 3800 => 4K
  // >= 1900 => 1080p
  // >= 1260 => 720p
  if (w >= 3800) {
    r.push({ key: "2160p", scaleW: 3840, bandwidth: 14000000 });
    r.push({ key: "1080p", scaleW: 1920, bandwidth: 5500000 });
    r.push({ key: "720p", scaleW: 1280, bandwidth: 3000000 });
  } else if (w >= 1900) {
    r.push({ key: "1080p", scaleW: 1920, bandwidth: 5500000 });
    r.push({ key: "720p", scaleW: 1280, bandwidth: 3000000 });
  } else if (w >= 1260) {
    r.push({ key: "720p", scaleW: 1280, bandwidth: 3000000 });
  } else {
    // fallback (você pode mudar para 480p se quiser)
    r.push({ key: "720p", scaleW: 1280, bandwidth: 2500000 });
  }
  return r;
}
