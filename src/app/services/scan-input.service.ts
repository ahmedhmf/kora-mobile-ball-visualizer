import { Injectable } from '@angular/core';

@Injectable({providedIn:'root'})
export class ScanInputService {
  async toCanvas(file: File): Promise<HTMLCanvasElement> {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    const image = await createImageBitmap(file, {imageOrientation:'from-image'});
    try {
      const scale = Math.min(1, 2600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext('2d', {willReadFrequently:true});
      if (!context) throw new Error('Cannot read photo.');
      context.drawImage(image,0,0,canvas.width,canvas.height);
      return canvas;
    } finally { image.close(); }
  }
  capture(video: HTMLVideoElement): HTMLCanvasElement {
    if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is not ready.');
    const scale = Math.min(1, 2600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Camera capture failed.');
    context.drawImage(video,0,0,canvas.width,canvas.height);
    return canvas;
  }
}
