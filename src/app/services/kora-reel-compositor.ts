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
    gradient.addColorStop(0, 'rgba(189,213,191,' + alpha + ')');
    gradient.addColorStop(0.55, 'rgba(137,178,151,' + (alpha * 0.4) + ')');
    gradient.addColorStop(1, 'rgba(137,178,151,0)');
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
  backdrop.addColorStop(0, '#09130f');
  backdrop.addColorStop(0.55, '#14271e');
  backdrop.addColorStop(1, '#060e0b');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(360, 775, 60, 360, 775, 570);
  glow.addColorStop(0, 'rgba(102,162,105,0.22)');
  glow.addColorStop(1, 'rgba(102,162,105,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 200, width, 1080);

  smoke(ctx, time, false);

  // Transparent Babylon scene: artwork remains crisp in front of rear smoke.
  // The translated placement reserves the top area for the brand mark.
  ctx.drawImage(modelCanvas, 0, 115, width, height);

  smoke(ctx, time, true);

  // The provided artwork is a black wordmark, so give it a luminous pale panel.
  ctx.save();
  ctx.shadowColor = 'rgba(213,245,190,0.22)';
  ctx.shadowBlur = 40;
  ctx.fillStyle = '#eaf3e0';
  ctx.beginPath();
  ctx.roundRect(57, 101, 606, 164, 27);
  ctx.fill();
  ctx.restore();
  ctx.drawImage(logo, 86, 117, 548, 117);

  const ground = ctx.createRadialGradient(360, 1165, 0, 360, 1165, 300);
  ground.addColorStop(0, 'rgba(182,225,157,0.075)');
  ground.addColorStop(1, 'rgba(182,225,157,0)');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 950, width, 330);
}
