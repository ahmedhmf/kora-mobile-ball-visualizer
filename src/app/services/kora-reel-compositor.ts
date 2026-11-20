/**
 * Portrait reel compositing. All smoke is drawn in screen space so it never
 * modifies the KORA ball texture or its registered UV seams.
 */
export const REEL_WIDTH = 720;
export const REEL_HEIGHT = 1280;

export async function loadReelLogo(): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = new URL('branding/kora-wordmark.svg', document.baseURI).toString();
  await image.decode();
  return image;
}

function smoke(ctx: CanvasRenderingContext2D, time: number, foreground: boolean): void {
  const count = foreground ? 12 : 28;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < count; i++) {
    const seed = i * 2.399963229728653;
    const drift = time * (0.28 + (i % 4) * 0.07);
    const side = i % 2 ? 1 : -1;
    const centerX = 360 + side * (175 + 110 * Math.sin(seed + drift * 0.38));
    const centerY = 760 + 260 * Math.cos(seed * 1.4 + drift * 0.23) - (time * (12 + i % 5) % 110);
    const radius = foreground ? 110 + (i % 4) * 25 : 185 + (i % 5) * 40;
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    const alpha = (foreground ? 0.024 : 0.037) * (0.75 + 0.25 * Math.sin(time * 0.9 + seed));
    gradient.addColorStop(0, 'rgba(255,104,108,' + alpha + ')');
    gradient.addColorStop(0.55, 'rgba(255,20,28,' + (alpha * 0.4) + ')');
    gradient.addColorStop(1, 'rgba(255,20,28,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
  }
  ctx.restore();
}

export function composeReelFrame(
  ctx: CanvasRenderingContext2D,
  modelCanvas: HTMLCanvasElement,
  logo: HTMLImageElement,
  time: number
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  const backdrop = ctx.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, '#050000');
  backdrop.addColorStop(0.55, '#250307');
  backdrop.addColorStop(1, '#030000');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(360, 775, 60, 360, 775, 570);
  glow.addColorStop(0, 'rgba(255,0,6,0.22)');
  glow.addColorStop(1, 'rgba(255,0,6,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 200, width, 1080);

  smoke(ctx, time, false);

  // Transparent Babylon scene: artwork remains crisp in front of rear smoke.
  // The translated placement reserves the top area for the brand mark.
  ctx.drawImage(modelCanvas, 0, 115, width, height);

  smoke(ctx, time, true);

  // Use the exact uploaded KORA wordmark as a transparent white overlay.
  // No background plaque; the shadow only softens contrast against smoke.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.72)';
  ctx.shadowBlur = 20;
  ctx.drawImage(logo, 86, 117, 548, 117);
  ctx.restore();

  const ground = ctx.createRadialGradient(360, 1165, 0, 360, 1165, 300);
  ground.addColorStop(0, 'rgba(255,25,32,0.075)');
  ground.addColorStop(1, 'rgba(255,25,32,0)');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 950, width, 330);
}
