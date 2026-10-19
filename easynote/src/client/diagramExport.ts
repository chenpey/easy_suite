export type DiagramImageFormat = 'svg' | 'png';

const THEME_VARIABLES = [
  '--pele-bg',
  '--pele-fg',
  '--pele-muted',
  '--pele-line',
  '--pele-surface',
  '--pele-surface-alt',
  '--pele-border',
  '--pele-accent',
  '--pele-critical',
  '--pele-error',
  '--pele-font',
  '--pele-font-mono',
  '--pele-radius',
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`),
];

function safeFilename(title: string, index: number, format: DiagramImageFormat) {
  const stem = title.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[.\s-]+$/g, '')
    .slice(0, 100) || 'easynote';
  return `${stem}-diagram-${index}.${format}`;
}

function standaloneDiagramSvg(source: SVGSVGElement): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const styles = getComputedStyle(source);
  for (const name of THEME_VARIABLES) {
    const value = styles.getPropertyValue(name).trim();
    if (value) clone.style.setProperty(name, value);
  }
  clone.style.fontFamily = styles.fontFamily;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.removeAttribute('tabindex');

  const width = source.viewBox.baseVal.width || source.getBoundingClientRect().width;
  const height = source.viewBox.baseVal.height || source.getBoundingClientRect().height;
  if (width <= 0 || height <= 0) throw new Error('Diagram has no drawable size.');
  clone.setAttribute('width', String(Math.ceil(width)));
  clone.setAttribute('height', String(Math.ceil(height)));

  // A standalone image has no page background behind it. Keep the current
  // theme's canvas so dark diagrams do not turn into white-on-white exports.
  const background = styles.getPropertyValue('--pele-bg').trim();
  if (background) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', background);
    clone.insertBefore(rect, clone.firstChild);
  }
  return clone;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function pngBlob(source: SVGSVGElement): Promise<Blob> {
  const svg = standaloneDiagramSvg(source);
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  const scale = Math.min(3, Math.max(1, 4096 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');

  const url = URL.createObjectURL(new Blob(
    [new XMLSerializer().serializeToString(svg)],
    { type: 'image/svg+xml;charset=utf-8' },
  ));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function downloadDiagram(
  source: SVGSVGElement,
  title: string,
  index: number,
  format: DiagramImageFormat,
) {
  if (format === 'svg') {
    const svg = standaloneDiagramSvg(source);
    downloadBlob(
      new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }),
      safeFilename(title, index, format),
    );
    return;
  }
  downloadBlob(await pngBlob(source), safeFilename(title, index, format));
}
