import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export interface KoraVideoExportOptions {
  width: number;
  height: number;
  fps: number;
  seconds: number;
}

/**
 * Encodes deterministic Babylon canvas frames as H.264 in a genuine MP4 container.
 * No intermediate images or scanned artwork leave the device.
 */
export async function encodeKoraMp4(
  canvas: HTMLCanvasElement,
  renderFrame: (index: number, total: number) => void,
  onProgress: (percent: number) => void,
  options: KoraVideoExportOptions = { width: 1280, height: 720, fps: 30, seconds: 8 }
): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('MP4 export requires browser WebCodecs support. Try an updated desktop Chrome or Edge browser.');
  }

  const config: VideoEncoderConfig = {
    codec: 'avc1.42001f', // H.264 Baseline Profile, Level 3.1 (720p30).
    width: options.width,
    height: options.height,
    framerate: options.fps,
    bitrate: 5_000_000,
    avc: { format: 'avc' },
    latencyMode: 'quality'
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error('This device cannot encode H.264 MP4 at 720p. Try a browser with H.264 WebCodecs encoding.');
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: options.width, height: options.height, frameRate: options.fps },
    fastStart: 'in-memory'
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: error => { encodeError = error; }
  });

  const total = options.seconds * options.fps;
  try {
    encoder.configure(config);
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError;
      // Prevent uncontrolled encoding queues from exhausting mobile device RAM.
      while (encoder.encodeQueueSize > 3) {
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        if (encodeError) throw encodeError;
      }
      renderFrame(i, total);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * 1_000_000 / options.fps),
        duration: Math.round(1_000_000 / options.fps)
      });
      try {
        encoder.encode(frame, { keyFrame: i % (options.fps * 2) === 0 });
      } finally {
        frame.close();
      }
      onProgress(Math.round(((i + 1) / total) * 95));
      // Yield periodically so progress/UI can repaint during rendering.
      if (i % 4 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    if (!target.buffer) throw new Error('The MP4 encoder produced no video.');
    onProgress(100);
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
