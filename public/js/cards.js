/**
 * cards.js — رندر کارت‌های UCHO با SVG (کارت‌ها انگلیسی می‌مانند)
 */
(function () {
  const C = {
    red:    { main: '#ff4757', dark: '#b71540', glow: '255,71,87' },
    yellow: { main: '#ffd32a', dark: '#c98f00', glow: '255,211,42' },
    green:  { main: '#2ed573', dark: '#128a43', glow: '46,213,115' },
    blue:   { main: '#3742fa', dark: '#1e2a9e', glow: '75,101,255' },
    wild:   { main: '#7d5fff', dark: '#3d2a8c', glow: '125,95,255' },
  };

  let uid = 0;
  function gid(prefix) { return prefix + '_' + (++uid); }

  function gradDef(color, id) {
    const c = C[color] || C.wild;
    return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c.main}"/>
      <stop offset="1" stop-color="${c.dark}"/>
    </linearGradient>`;
  }

  // ---- symbol paths (drawn inside 0 0 100 100 box) ----
  function symSkip(fill) {
    return `<g fill="none" stroke="${fill}" stroke-width="10">
      <circle cx="50" cy="50" r="34"/>
      <line x1="26" y1="74" x2="74" y2="26"/>
    </g>`;
  }
  function symReverse(fill) {
    return `<g fill="${fill}">
      <path d="M32 40 L32 60 Q32 66 26 66 L24 66 Q18 66 18 60 L18 34 Q18 28 24 28 L52 28 L52 14 L76 32 L52 50 L52 36 L38 36 Z"/>
      <path d="M68 60 L68 40 Q68 34 74 34 L76 34 Q82 34 82 40 L82 66 Q82 72 76 72 L48 72 L48 86 L24 68 L48 50 L48 64 L62 64 Z"/>
    </g>`;
  }
  function symDraw2(fill, stroke) {
    return `<g>
      <rect x="18" y="26" width="38" height="52" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="4" transform="rotate(-12 37 52)"/>
      <rect x="44" y="22" width="38" height="52" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="4" transform="rotate(10 63 48)"/>
    </g>`;
  }
  function wildQuadrants(cx, cy, rx, ry, rot, clipId) {
    let out = `<g transform="rotate(${rot} ${cx} ${cy})" clip-path="url(#${clipId})">`;
    out += `<rect x="${cx - rx}" y="${cy - ry}" width="${rx}" height="${ry}" fill="${C.red.main}"/>`;
    out += `<rect x="${cx}" y="${cy - ry}" width="${rx}" height="${ry}" fill="${C.blue.main}"/>`;
    out += `<rect x="${cx - rx}" y="${cy}" width="${rx}" height="${ry}" fill="${C.yellow.main}"/>`;
    out += `<rect x="${cx}" y="${cy}" width="${rx}" height="${ry}" fill="${C.green.main}"/>`;
    out += `</g>`;
    return out;
  }

  function cornerText(num, c, sign) {
    const x = sign === 1 ? 42 : 198;
    const y = sign === 1 ? 78 : 310;
    const rot = sign === 1 ? -90 : 90;
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="58" font-weight="900" font-family="Arial, sans-serif"
      fill="#fff" stroke="rgba(0,0,0,.3)" stroke-width="3" style="paint-order:stroke" transform="rotate(${rot} ${x} ${y})">${num}</text>`;
  }

  function cornerIcon(symSvg, sign) {
    const x = sign === 1 ? 42 : 198;
    const y = sign === 1 ? 44 : 316;
    const rot = sign === 1 ? -90 : 90;
    return `<g transform="translate(${x - 17} ${y - 17}) rotate(${rot}) scale(0.34)">${symSvg}</g>`;
  }

  /**
   * Generate a UNO card SVG string.
   * card: {color, value} — value: '0'-'9','skip','reverse','draw2','wild','wild4'
   */
  function cardSVG(card) {
    const w = 240, h = 360;
    const isWild = card.color === 'wild';
    const baseColor = isWild ? 'wild' : card.color;
    const gradId = gid('g');
    const c = C[baseColor];
    const num = card.value;

    // center symbol + corners
    let center = '', cornerTL = '', cornerBR = '', wildCorners = '';

    if (/^\d$/.test(num)) {
      const t = `x="120" text-anchor="middle" font-size="170" font-weight="900" font-family="Arial, sans-serif" transform="rotate(-14 120 180)"`;
      center = `<text ${t} y="253" fill="${c.dark}" stroke="rgba(0,0,0,.25)" stroke-width="3">${num}</text>
        <text ${t} y="250" fill="#fff">${num}</text>`;
      cornerTL = cornerText(num, c, 1);
      cornerBR = cornerText(num, c, -1);
    } else if (num === 'skip') {
      center = `<g transform="translate(45 105) scale(1.5)">${symSkip('#fff')}</g>`;
      cornerTL = cornerIcon(symSkip(c.dark), 1);
      cornerBR = cornerIcon(symSkip(c.dark), -1);
    } else if (num === 'reverse') {
      center = `<g transform="translate(40 100) scale(1.6)">${symReverse('#fff')}</g>`;
      cornerTL = cornerIcon(symReverse(c.dark), 1);
      cornerBR = cornerIcon(symReverse(c.dark), -1);
    } else if (num === 'draw2') {
      center = `<g transform="translate(20 95) scale(2.0)">${symDraw2('#fff', c.dark)}</g>
        <text x="120" y="330" text-anchor="middle" font-size="46" font-weight="900" font-family="Arial, sans-serif" fill="#fff" transform="rotate(-10 120 310)">+2</text>`;
      cornerTL = cornerIcon(symDraw2(c.dark, '#fff'), 1);
      cornerBR = cornerIcon(symDraw2(c.dark, '#fff'), -1);
    } else if (num === 'wild') {
      const clipId = gid('clip');
      center = `<clipPath id="${clipId}"><ellipse cx="120" cy="180" rx="92" ry="140" transform="rotate(-30 120 180)"/></clipPath>
        ${wildQuadrants(120, 180, 92, 140, -30, clipId)}
        <ellipse cx="120" cy="180" rx="92" ry="140" transform="rotate(-30 120 180)" fill="none" stroke="#fff" stroke-width="7"/>`;
      const c1 = gid('wc1'), c2 = gid('wc2');
      wildCorners = `
        <clipPath id="${c1}"><ellipse cx="40" cy="44" rx="24" ry="36" transform="rotate(-25 40 44)"/></clipPath>
        ${wildQuadrants(40, 44, 30, 42, -25, c1)}
        <clipPath id="${c2}"><ellipse cx="200" cy="316" rx="24" ry="36" transform="rotate(-25 200 316)"/></clipPath>
        ${wildQuadrants(200, 316, 30, 42, -25, c2)}`;
    } else if (num === 'wild4') {
      const clipId = gid('clip');
      center = `<clipPath id="${clipId}"><ellipse cx="120" cy="180" rx="92" ry="140" transform="rotate(-30 120 180)"/></clipPath>
        ${wildQuadrants(120, 180, 92, 140, -30, clipId)}
        <ellipse cx="120" cy="180" rx="92" ry="140" transform="rotate(-30 120 180)" fill="none" stroke="#fff" stroke-width="7"/>
        <text x="120" y="212" text-anchor="middle" font-size="110" font-weight="900" font-family="Arial, sans-serif" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="5" style="paint-order:stroke" transform="rotate(-12 120 180)">+4</text>`;
      const c1 = gid('wc1'), c2 = gid('wc2');
      wildCorners = `
        <clipPath id="${c1}"><ellipse cx="40" cy="44" rx="24" ry="36" transform="rotate(-25 40 44)"/></clipPath>
        ${wildQuadrants(40, 44, 30, 42, -25, c1)}
        <clipPath id="${c2}"><ellipse cx="200" cy="316" rx="24" ry="36" transform="rotate(-25 200 316)"/></clipPath>
        ${wildQuadrants(200, 316, 30, 42, -25, c2)}`;
    }

    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="uno-card-svg" preserveAspectRatio="xMidYMid meet">
      <defs>${gradDef(baseColor, gradId)}</defs>
      <rect x="6" y="6" width="228" height="348" rx="30" fill="#0d0d1c"/>
      <rect x="12" y="12" width="216" height="336" rx="25" fill="url(#${gradId})"/>
      <rect x="21" y="21" width="198" height="318" rx="18" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="5"/>
      ${center}
      ${cornerTL}
      ${cornerBR}
      ${wildCorners}
      <rect x="6" y="6" width="228" height="348" rx="30" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    </svg>`;
  }


  /** Card back (for deck pile) — UCHO wordmark */
  function cardBackSVG() {
    const id = gid('rb');
    const clipId = id + '_c';
    return `<svg viewBox="0 0 240 360" xmlns="http://www.w3.org/2000/svg" class="uno-card-svg">
      <defs>${gradDef('red', id)}</defs>
      <rect x="6" y="6" width="228" height="348" rx="30" fill="#0d0d1c"/>
      <rect x="12" y="12" width="216" height="336" rx="25" fill="#111124"/>
      <clipPath id="${clipId}"><ellipse cx="120" cy="180" rx="88" ry="136" transform="rotate(-30 120 180)"/></clipPath>
      <g clip-path="url(#${clipId})"><rect x="10" y="10" width="220" height="340" fill="url(#${id})"/></g>
      <ellipse cx="120" cy="180" rx="88" ry="136" transform="rotate(-30 120 180)" fill="none" stroke="#fff" stroke-width="7"/>
      <text x="120" y="200" text-anchor="middle" font-size="52" font-weight="900" letter-spacing="4"
        font-family="Arial Black, Arial, sans-serif" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="2"
        style="paint-order:stroke" transform="rotate(-30 120 180)">UCHO</text>
      <text x="120" y="228" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="6"
        font-family="Arial, sans-serif" fill="rgba(255,255,255,.85)" transform="rotate(-30 120 180)">ONLINE</text>
      <rect x="6" y="6" width="228" height="348" rx="30" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    </svg>`;
  }

  /** Big UCHO logo for splash */
  function logoSVG(size) {
    size = size || 140;
    const id = gid('lg');
    const clipId = id + '_c';
    return `<svg width="${size}" height="${Math.round(size * 1.5)}" viewBox="0 0 240 360" xmlns="http://www.w3.org/2000/svg">
      <defs>${gradDef('red', id)}</defs>
      <rect x="6" y="6" width="228" height="348" rx="30" fill="#0d0d1c"/>
      <rect x="12" y="12" width="216" height="336" rx="25" fill="url(#${id})"/>
      <clipPath id="${clipId}"><ellipse cx="120" cy="180" rx="88" ry="136" transform="rotate(-30 120 180)"/></clipPath>
      <g clip-path="url(#${clipId})"><rect x="10" y="10" width="220" height="340" fill="#fff"/></g>
      <ellipse cx="120" cy="180" rx="88" ry="136" transform="rotate(-30 120 180)" fill="none" stroke="rgba(0,0,0,.2)" stroke-width="5"/>
      <text x="120" y="196" text-anchor="middle" font-size="46" font-weight="900" letter-spacing="3"
        font-family="Arial Black, Arial, sans-serif" fill="${C.red.dark}" transform="rotate(-14 120 180)">UCHO</text>
      <text x="120" y="222" text-anchor="middle" font-size="14" font-weight="700" letter-spacing="5"
        font-family="Arial, sans-serif" fill="rgba(0,0,0,.55)" transform="rotate(-14 120 180)">ONLINE</text>
    </svg>`;
  }

  const CARD_COLORS = ['red', 'yellow', 'green', 'blue'];

  window.UNOCards = { cardSVG, cardBackSVG, logoSVG, CARD_COLORS, colorInfo: C };
})();

