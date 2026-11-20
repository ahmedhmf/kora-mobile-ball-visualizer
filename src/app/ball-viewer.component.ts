import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { ArcRotateCamera, Color3, Color4, Engine, HemisphericLight, Mesh, PBRMaterial, Scene, SceneLoader, Texture, Vector3 } from '@babylonjs/core';
import { OBJFileLoader } from '@babylonjs/loaders/OBJ';

OBJFileLoader.SKIP_MATERIALS = true;

@Component({
  selector: 'app-ball-viewer', standalone: true,
  template: '<canvas #surface aria-label="Interactive KORA ball. Drag to rotate, pinch to zoom."></canvas>',
  styles: [':host{display:block;width:100%;height:100%;min-height:340px}canvas{width:100%;height:100%;display:block;touch-action:none}']
})
export class BallViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('surface', {static: true}) surface!: ElementRef<HTMLCanvasElement>;
  private engine?: Engine;
  private scene?: Scene;
  private material?: PBRMaterial;
  private texture?: Texture;
  private ready?: Promise<void>;
  private readonly resize = () => this.engine?.resize();

  ngAfterViewInit(): void {
    this.engine = new Engine(this.surface.nativeElement, true);
    const scene = new Scene(this.engine);
    this.scene = scene;
    scene.clearColor = new Color4(0.05, 0.09, 0.07, 1);
    const camera = new ArcRotateCamera('camera', Math.PI / 2, Math.PI / 2.4, 6, Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 2.5;
    camera.upperRadiusLimit = 10;
    camera.attachControl(this.surface.nativeElement, true);
    const light = new HemisphericLight('light', new Vector3(1, 2, 1), scene);
    light.intensity = 1.5;
    this.material = new PBRMaterial('kora', scene);
    this.material.albedoColor = Color3.White();
    this.material.metallic = 0;
    this.material.roughness = 0.83;
    this.ready = this.loadModel(scene);
    this.engine.runRenderLoop(() => scene.render());
    window.addEventListener('resize', this.resize);
  }

  private async loadModel(scene: Scene): Promise<void> {
    // Pinned, exact 32-CLB OBJ. Bundle locally before production/offline release.
    const url = 'https://raw.githubusercontent.com/ahmedhmf/kora-ball-viewer/08c7765525aa8692b207d535b6cfce9027e6c345/public/3d-models/32-CLB.obj';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load KORA model.');
    const blobUrl = URL.createObjectURL(await response.blob());
    try {
      const result = await SceneLoader.ImportMeshAsync('', '', blobUrl, scene, undefined, '.obj');
      const meshes = result.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
      if (!meshes.length) throw new Error('KORA model contained no geometry.');
      let min = meshes[0].getBoundingInfo().boundingBox.minimumWorld.clone();
      let max = meshes[0].getBoundingInfo().boundingBox.maximumWorld.clone();
      for (const mesh of meshes.slice(1)) {
        min = Vector3.Minimize(min, mesh.getBoundingInfo().boundingBox.minimumWorld);
        max = Vector3.Maximize(max, mesh.getBoundingInfo().boundingBox.maximumWorld);
      }
      const center = Vector3.Center(min, max);
      const scale = 3.6 / Math.max(0.0001, Vector3.Distance(min, max));
      for (const mesh of meshes) {
        mesh.position.subtractInPlace(center);
        mesh.bakeCurrentTransformIntoVertices();
        mesh.scaling.scaleInPlace(scale);
        mesh.material = this.material!;
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async apply(atlas: HTMLCanvasElement): Promise<void> {
    await this.ready;
    if (!this.scene || !this.material) throw new Error('Viewer is not initialized.');
    const scene = this.scene;
    const next = await new Promise<Texture>((resolve, reject) => {
      const texture = new Texture(atlas.toDataURL('image/png'), scene, false, true,
        Texture.TRILINEAR_SAMPLINGMODE, () => resolve(texture),
        (message) => reject(new Error(message)));
    });
    const old = this.texture;
    this.texture = next;
    this.material.albedoTexture = next;
    old?.dispose();
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.resize);
    this.texture?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
  }
}
