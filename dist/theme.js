// Apply the saved interface theme before the stylesheet paints the page.
(() => {
  const defaultAccent = '#df82b1';
  const icon = document.querySelector('link[rel="icon"]');
  const defaultIcon = icon?.href;
  function updateIcon(color, luminance) {
    if (!icon) return;
    if (color === defaultAccent) {
      icon.href = defaultIcon;
      return;
    }
    const ink = luminance > 0.22 ? '#2c1825' : '#ffffff';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="12" fill="${color}"/>
  <g transform="translate(7 7) scale(1.42)" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="3" width="14" height="18" rx="2"/>
    <path d="M10 3v18M4 7h4M4 12h4M4 17h4M13 8h4M13 12h4"/>
  </g>
</svg>`;
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  function updateThemeColor() {
    const root = document.documentElement;
    const color = root.dataset.accent || defaultAccent;
    const base = root.dataset.theme === 'dark' ? 25 : 250;
    const background = '#' + [1, 3, 5].map(start =>
      Math.round(parseInt(color.slice(start, start + 2), 16) * 0.04 + base * 0.96)
        .toString(16).padStart(2, '0')).join('');
    document.querySelector('meta[name="theme-color"]').content = background;
  }
  function applyAccent(value) {
    const color = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : defaultAccent;
    const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255);
    const luminance = rgb.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const root = document.documentElement;
    root.dataset.accent = color;
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-ink', luminance > 0.45 ? '#201b22' : '#ffffff');
    updateIcon(color, luminance);
    updateThemeColor();
  }
  window.vibenotesAppearance = { applyAccent, defaultAccent, updateThemeColor };
  let theme = 'light', accent = defaultAccent;
  try {
    if (localStorage.getItem('vibenotes-theme') === 'dark') theme = 'dark';
    accent = localStorage.getItem('vibenotes-accent') || defaultAccent;
  } catch { /* The interface still works when browser storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  applyAccent(accent);
})();
