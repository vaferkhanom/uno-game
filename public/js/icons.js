/**
 * icons.js — آیکون‌های خطی SVG به‌جای ایموجی
 * همهٔ آیکون‌ها stroke-based هستند و با currentColor رنگ می‌گیرند.
 */
(function () {
  const S = (inner, vb) =>
    `<svg class="icon" viewBox="${vb || '0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const defs = {
    robot: S(`<rect x="4" y="8" width="16" height="12" rx="3"/>
      <path d="M12 8V4M9 4h6"/>
      <circle cx="9" cy="13.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="15" cy="13.5" r="1" fill="currentColor" stroke="none"/>
      <path d="M9.5 17h5"/>
      <path d="M2 13v3M22 13v3"/>`),
    controller: S(`<rect x="2.5" y="7" width="19" height="11" rx="5"/>
      <path d="M8 11v3M6.5 12.5h3"/>
      <circle cx="15.5" cy="11.5" r=".8" fill="currentColor" stroke="none"/>
      <circle cx="17.8" cy="13.8" r=".8" fill="currentColor" stroke="none"/>`),
    key: S(`<circle cx="8" cy="15" r="4"/><path d="M11 12L20 3M16 4l3 3M13 7l2.5 2.5"/>`),
    scroll: S(`<path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2h3z"/>
      <path d="M9 9h6M9 13h6M9 17h4"/>`),
    copy: S(`<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
    share: S(`<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>
      <path d="M16 6l-4-4-4 4M12 2v13"/>`),
    door: S(`<path d="M4 21h16M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/>
      <circle cx="14.5" cy="12" r=".9" fill="currentColor" stroke="none"/>`),
    check: S(`<path d="M20 6L9 17l-5-5"/>`),
    trophy: S(`<path d="M8 21h8M12 17v4"/>
      <path d="M7 4h10v6a5 5 0 0 1-10 0V4z"/>
      <path d="M7 6H4a1 1 0 0 0-1 1c0 2.2 1.8 4 4 4M17 6h3a1 1 0 0 1 1 1c0 2.2-1.8 4-4 4"/>`),
    refresh: S(`<path d="M21 12a9 9 0 1 1-2.6-6.3"/>
      <path d="M21 3v5h-5"/>`),
    sparkle: S(`<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>`),
    skip: S(`<circle cx="12" cy="12" r="9"/><path d="M5.8 5.8l12.4 12.4"/>`),
    reverse: S(`<path d="M8 3L4 7l4 4"/>
      <path d="M4 7h12a4 4 0 0 1 4 4v1"/>
      <path d="M16 21l4-4-4-4"/>
      <path d="M20 17H8a4 4 0 0 1-4-4v-1"/>`),
    draw2: S(`<rect x="3" y="7" width="11" height="15" rx="2" transform="rotate(-8 8.5 14.5)"/>
      <rect x="9" y="4" width="11" height="15" rx="2" transform="rotate(8 14.5 11.5)"/>
      <path d="M15 9v6M12 12h6" stroke-width="2.2"/>`),
    wild: S(`<circle cx="12" cy="12" r="9"/>
      <path d="M12 3a9 9 0 0 0 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z" fill="currentColor" stroke="none" opacity=".35"/>
      <circle cx="12" cy="12" r="2.2"/>`),
    wild4: S(`<circle cx="12" cy="12" r="9"/>
      <path d="M12 3a9 9 0 0 0 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z" fill="currentColor" stroke="none" opacity=".35"/>
      <path d="M9.5 14.5l5-6M14.5 14.5v-6M9.5 14.5h5" stroke-width="1.6"/>`),
    hand: S(`<path d="M12 3V1.5"/>
      <circle cx="12" cy="13" r="9"/>`),
    uno: S(`<path d="M11 3.8a9.2 9.2 0 0 1 9 9.4M11 3.8L7.5 7M11 3.8L14.5 7"/>
      <path d="M13 20.2a9.2 9.2 0 0 1-9-9.4M13 20.2l3.5-3.2M13 20.2l-3.5-3.2"/>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>`),
    siren: S(`<path d="M6 19v-5a6 6 0 0 1 12 0v5"/>
      <path d="M4 21h16"/>
      <path d="M12 3v2M5.6 5.6l1.4 1.4M18.4 5.6L17 7"/>`),
    book: S(`<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/>
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>
      <path d="M9 8h7M9 11.5h5"/>`),
    target: S(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>`),
    palette: S(`<path d="M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-2 2c0 1 .5 1.5.5 2.5S13.5 21 12 21z"/>
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="16.5" cy="10.5" r="1" fill="currentColor" stroke="none"/>`),
    play: S(`<path d="M7 4.5l12 7.5-12 7.5v-15z"/>`),
    dice: S(`<rect x="4" y="4" width="16" height="16" rx="3.5"/>
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none"/>
      <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/>
      <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none"/>
      <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none"/>`),
    exit: S(`<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/>
      <path d="M10 17l-5-5 5-5M5 12h11"/>`),
    cards: S(`<rect x="3" y="6" width="11" height="15" rx="2" transform="rotate(-10 8.5 13.5)"/>
      <rect x="10" y="3" width="11" height="15" rx="2" transform="rotate(10 15.5 10.5)"/>`),
    clock: S(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
    moon: S(`<path d="M21 13.5A8.5 8.5 0 1 1 10.5 3 7 7 0 0 0 21 13.5z"/>`),
    crown: S(`<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.5 11h-15L3 8z"/>`),
    rocket: S(`<path d="M12 15c-2-1-3.5-3.5-3.5-6C8.5 5 10.5 3 12 2c1.5 1 3.5 3 3.5 7 0 2.5-1.5 5-3.5 6z"/>
      <path d="M8.5 12L5 14.5l1.5 3M15.5 12l3.5 2.5-1.5 3"/>
      <path d="M10 18c0 2-1 3.5-2.5 4M14 18c0 2 1 3.5 2.5 4"/>`),
    hourglass: S(`<path d="M7 3h10M7 21h10"/>
      <path d="M8 3v3.5L12 11l4-4.5V3M8 21v-3.5L12 13l4 4.5V21"/>`),
    thumbs: S(`<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3z"/>
      <path d="M7 11l4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1 5.5a2 2 0 0 1-2 1.7H7"/>`),
    bulb: S(`<path d="M9 18h6M10 21h4"/>
      <path d="M12 3a6 6 0 0 1 3.5 10.9c-.7.5-1 1.3-1 2.1h-5c0-.8-.3-1.6-1-2.1A6 6 0 0 1 12 3z"/>`),
    chart: S(`<path d="M4 20V4"/><path d="M4 20h16"/>
      <path d="M8 16v-4M12 16V8M16 16v-6"/>`),
    users: S(`<circle cx="9" cy="8" r="3.5"/>
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
      <circle cx="17" cy="9" r="2.5"/>
      <path d="M17 14.5c2.5 0 4 2 4 4.5"/>`),
    home: S(`<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>`),
    question: S(`<circle cx="12" cy="12" r="9"/>
      <path d="M9.5 9.2a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.1 1-1.1 1.8v.4"/>
      <circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>`),
    back: S(`<path d="M20 12H4M10 6l-6 6 6 6"/>`),
    forward: S(`<path d="M4 12h16M14 6l6 6-6 6"/>`),
    chat: S(`<path d="M21 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 21 12z"/>`),
    link: S(`<path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.9"/>
      <path d="M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 18.1"/>`),
    pin: S(`<path d="M12 21s-6.5-5.5-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.5 12 21 12 21z"/>
      <circle cx="12" cy="10.5" r="2.2"/>`),
    user: S(`<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>`),
    trend: S(`<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>`),
    star: S(`<path d="M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8L12 3z"/>`),
    thinking: S(`<circle cx="12" cy="12" r="9"/>
      <path d="M9 10h.01M15 10h.01"/>
      <path d="M9.5 15.5c1.5 1 3.5 1 5-.2"/>`),
    stop: S(`<circle cx="12" cy="12" r="9"/><path d="M5.8 5.8l12.4 12.4"/>`),
  };

  /** icon('name', sizeClass?) → svg string */
  function icon(name) {
    const d = defs[name];
    return d || defs.stop;
  }

  window.UNOIcons = { icon, has: (n) => !!defs[n] };
})();
