// Tock Sniper icon — a restaurant service bell, rung the instant slots open.
// svg(size) returns the SVG for one PNG size. 16 px is drawn on its own pixel grid (no sparks,
// no highlight) rather than scaled down, so it stays crisp in the toolbar.
// Render with: node scripts/render-icons.mjs

const ORANGE_LIGHT = "#ffb547";
const ORANGE_DARK = "#f2621f";

export function svg(size) {
  return size <= 16 ? svg16() : svgLarge(size);
}

// 48 / 128: Chrome Web Store asks for a 96×96 artwork inside the 128 canvas (16 px transparent
// padding); 48 is shown on chrome://extensions, where a little padding keeps it from looking cramped.
function svgLarge(size) {
  const pad = size >= 128 ? 16 : 2;
  const w = size - 2 * pad;
  const k = w / 96;                 // design units: a 96×96 tile
  const x = (u) => pad + u * k;     // design → pixels
  const d = (u) => u * k;
  const detailed = size >= 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ORANGE_LIGHT}"/><stop offset="1" stop-color="${ORANGE_DARK}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="dome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fff3e6"/>
    </linearGradient>
  </defs>
  <rect x="${pad}" y="${pad}" width="${w}" height="${w}" rx="${d(22)}" fill="url(#bg)"/>
  <rect x="${pad}" y="${pad}" width="${w}" height="${w}" rx="${d(22)}" fill="url(#sheen)"/>
  <g stroke="#fff" stroke-width="${d(4.6)}" stroke-linecap="round">
    <line x1="${x(48)}" y1="${x(12)}" x2="${x(48)}" y2="${x(20)}"/>
    <line x1="${x(24)}" y1="${x(20.5)}" x2="${x(29)}" y2="${x(26.5)}"/>
    <line x1="${x(72)}" y1="${x(20.5)}" x2="${x(67)}" y2="${x(26.5)}"/>
  </g>
  ${detailed ? `<ellipse cx="${x(48)}" cy="${x(81)}" rx="${d(36)}" ry="${d(3.6)}" fill="#a83a0c" fill-opacity=".28"/>` : ""}
  <rect x="${x(43.5)}" y="${x(28.5)}" width="${d(9)}" height="${d(8)}" rx="${d(3)}" fill="#fff"/>
  <path d="M${x(18)} ${x(69)} A${d(30)} ${d(32)} 0 0 1 ${x(78)} ${x(69)} Z" fill="url(#dome)"/>
  ${detailed ? `<path d="M${x(31)} ${x(60)} A${d(19)} ${d(20)} 0 0 1 ${x(41)} ${x(45)}" fill="none" stroke="${ORANGE_DARK}" stroke-opacity=".32" stroke-width="${d(4)}" stroke-linecap="round"/>` : ""}
  <rect x="${x(11)}" y="${x(71)}" width="${d(74)}" height="${d(8.5)}" rx="${d(4.25)}" fill="#fff"/>
</svg>`;
}

// Hand-placed on the 16×16 grid: full-bleed tile, dome + base + knob only.
function svg16() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ORANGE_LIGHT}"/><stop offset="1" stop-color="${ORANGE_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="16" height="16" rx="3.5" fill="url(#bg)"/>
  <!-- whole-pixel edges: knob rows 2–3, dome down to row 9, one orange row, base rows 11–12 -->
  <rect x="7" y="2" width="2" height="2" rx=".6" fill="#fff"/>
  <path d="M3 10 A5 5.5 0 0 1 13 10 Z" fill="#fff"/>
  <rect x="2" y="11" width="12" height="2" rx="1" fill="#fff"/>
</svg>`;
}
