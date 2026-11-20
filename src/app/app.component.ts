import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { BallViewerComponent } from './ball-viewer.component';
import { BallTexturePreparationService } from './services/ball-texture-preparation.service';
import { ScanInputService } from './services/scan-input.service';
import { KoraWallPublishService } from './services/kora-wall-publish.service';

type Stage = 'start' | 'camera' | 'review' | 'preparing' | 'ball';

@Component({
  selector:'app-root', standalone:true, imports:[BallViewerComponent],
  templateUrl:'./app.component.html', styleUrl:'./app.component.css'
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;
  @ViewChild('picker', {static:true}) picker!: ElementRef<HTMLInputElement>;
  @ViewChild(BallViewerComponent) viewer?: BallViewerComponent;
  readonly stage = signal<Stage>('start');
  readonly error = signal('');
  readonly status = signal('');
  readonly image = signal('');
  readonly uncertain = signal(false);
  readonly ready = signal(false);
  readonly exporting = signal(false);
  readonly exportPercent = signal(0);
  readonly wallBusy = signal(false);
  readonly wallResult = signal('');
  private preparedMp4?: Blob;
  private readonly prepare = inject(BallTexturePreparationService);
  private readonly inputs = inject(ScanInputService);
  private readonly wall = inject(KoraWallPublishService);
  private stream?: MediaStream;
  private source?: HTMLCanvasElement;
  private imageUrl?: string;
  private pending?: HTMLCanvasElement;
  private pendingGeneration = 0;

  ngAfterViewInit(): void { document.addEventListener('visibilitychange', this.visibility); }
  private visibility = () => { if (document.hidden) this.stopCamera(); };
  private stopCamera(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = undefined;
    if (this.video?.nativeElement) this.video.nativeElement.srcObject = null;
  }
  async startCamera(): Promise<void> {
    this.stopCamera();
    this.error.set('');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('Live camera is not supported here. Upload a photo or PDF instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio:false, video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:2560}}
      });
      this.stream = stream;
      this.stage.set('camera');
      requestAnimationFrame(() => {
        const video = this.video?.nativeElement;
        if (video && this.stream === stream) {
          video.srcObject = stream;
          void video.play().catch(() => this.error.set('Camera preview could not start.'));
        }
      });
    } catch {
      this.error.set('Camera access was not granted. You can upload an existing photo or PDF.');
      this.stopCamera();
    }
  }
  capture(): void {
    try {
      const video = this.video?.nativeElement;
      if (!video) throw new Error('Camera preview is unavailable.');
      this.review(this.inputs.capture(video));
    } catch (error) { this.error.set(this.message(error)); }
  }
  upload(): void { this.picker.nativeElement.click(); }
  async selected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf && !file.type.startsWith('image/')) throw new Error('Choose a photo or PDF.');
      const source = isPdf ? await this.prepare.readPdf(file) : await this.inputs.toCanvas(file);
      this.review(source);
    } catch (error) { this.error.set(this.message(error)); }
  }
  private review(source: HTMLCanvasElement): void {
    this.stopCamera();
    this.source = source;
    this.preparedMp4 = undefined;
    this.wallResult.set('');
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    const url = source.toDataURL('image/jpeg', .82);
    this.image.set(url);
    this.stage.set('review');
  }
  async useScan(rotate = false): Promise<void> {
    if (!this.source) return;
    const generation = ++this.pendingGeneration;
    this.stage.set('preparing');
    this.status.set('Checking your print…');
    this.error.set('');
    try {
      const source = rotate ? this.prepare.rotatePage180(this.source) : this.source;
      const result = await this.prepare.prepare(source, true, true, s => this.status.set(s));
      if (generation !== this.pendingGeneration) return;
      this.uncertain.set(result.orientationUncertain);
      this.preparedMp4 = undefined;
      this.pending = result.atlas;
      this.stage.set('ball');
      requestAnimationFrame(() => void this.applyPending(generation));
    } catch (error) {
      if (generation !== this.pendingGeneration) return;
      this.error.set(this.message(error));
      this.stage.set('review');
    }
  }
  directAtlas(): void {
    if (!this.source || this.source.width !== 1024 || this.source.height !== 1024) {
      this.error.set('A UV-ready atlas must be exactly 1024 × 1024 pixels.');
      return;
    }
    const generation = ++this.pendingGeneration;
    this.preparedMp4 = undefined;
    this.pending = this.source;
    this.uncertain.set(false);
    this.stage.set('ball');
    requestAnimationFrame(() => void this.applyPending(generation));
  }
  private async applyPending(generation: number): Promise<void> {
    try {
      if (!this.pending || !this.viewer) throw new Error('3D viewer was not initialized.');
      await this.viewer.apply(this.pending);
      if (generation !== this.pendingGeneration) return;
      this.ready.set(true);
      this.status.set('Ready');
      // Auto-encode and upload only AFTER the texture has been applied.
      // No input or manual publish action is required per generated ball.
      void this.autoPublishMp4(generation);
    } catch (error) {
      if (generation === this.pendingGeneration) this.error.set(this.message(error));
    }
  }
  async downloadMp4(): Promise<void> {
    if (this.exporting() || this.wallBusy() || !this.ready() || !this.viewer) return;
    this.error.set('');
    this.exportPercent.set(0);
    this.exporting.set(true);
    try {
      const mp4 = this.preparedMp4 ?? await this.viewer.exportMp4(progress => this.exportPercent.set(progress));
      this.preparedMp4 = mp4;
      const url = URL.createObjectURL(mp4);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'kora-ball-360-instagram-reel.mp4';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Safari may need extra time to hand the Blob URL to the download manager.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.exporting.set(false);
    }
  }

  private async autoPublishMp4(generation: number): Promise<void> {
    if (generation !== this.pendingGeneration || this.wallBusy() || !this.viewer) return;
    this.wallResult.set('');
    this.exportPercent.set(0);
    this.wallBusy.set(true);
    try {
      const mp4 = this.preparedMp4 ?? await this.viewer.exportMp4(p => this.exportPercent.set(p));
      if (generation !== this.pendingGeneration) return;
      this.preparedMp4 = mp4; // Keep for optional download without rendering twice.
      this.wallResult.set('MP4 rendered. Uploading to private Supabase Storage…');
      await this.wall.publish(mp4);
      if (generation === this.pendingGeneration) {
        this.wallResult.set('MP4 uploaded to Supabase and automatically published to the event TV feed.');
      }
    } catch (error) {
      if (generation === this.pendingGeneration) {
        this.wallResult.set('Automatic MP4 upload failed: ' + this.message(error));
      }
    } finally {
      this.wallBusy.set(false);
    }
  }

  reset(): void {
    if (this.exporting() || this.wallBusy()) return;
    ++this.pendingGeneration;
    this.stopCamera();
    this.source = undefined;
    this.pending = undefined;
    this.preparedMp4 = undefined;
    this.wallResult.set('');
    this.ready.set(false);
    this.error.set('');
    this.stage.set('start');
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  ngOnDestroy(): void {
    this.stopCamera();
    document.removeEventListener('visibilitychange',this.visibility);
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
  }
}
