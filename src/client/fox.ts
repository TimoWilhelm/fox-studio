import {
  AnimationMixer, Bone, BufferAttribute, CatmullRomCurve3, CircleGeometry, Color, DataTexture,
  DirectionalLight, Euler, ExtrudeGeometry, Group, HemisphereLight, Material, Matrix4, Mesh,
  MeshBasicMaterial, MeshToonMaterial, NearestFilter, NoToneMapping, Object3D,
  OrthographicCamera, Quaternion, RedFormat, Scene, ShaderMaterial, Shape, SkinnedMesh,
  SphereGeometry, SRGBColorSpace, Texture, TubeGeometry, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { AvatarAnimator, type AvatarFrame } from '../shared/animation';
import { clamp, type Pose } from '../shared/expression';

export const modelCredit = { label: 'Fox by Quaternius', url: 'https://poly.pizza/m/Bc97C66HKi' };
export const backgrounds = [
  { id: 'paper', label: 'Paper', color: '#f2f0eb' },
  { id: 'peach', label: 'Peach', color: '#f0d8c9' },
  { id: 'sage', label: 'Sage', color: '#d4ddd0' },
  { id: 'night', label: 'Night', color: '#344152' },
] as const;
export type Background = typeof backgrounds[number]['id'];

const palette: Record<string, string> = { Main: '#e7a269', Main_Light: '#fff2df', Grey: '#4f403d', Black: '#302725', Eyes: '#302725' };
const headEuler = new Euler(), worldHead = new Quaternion(), parentRotation = new Quaternion();
const vertex = new Vector3(), target = new Vector3();

/** The downloaded animal mesh and skeleton remain the base of the avatar. */
export function createFoxRig(gltf: GLTF) {
  const root = new Group(), torso = new Group(); torso.position.y = -1.45; root.add(torso);
  const model = gltf.scene;
  // The export opens in an attack pose. Use the artist's symmetric neutral pose.
  const idle = gltf.animations.find(clip => clip.name === 'Idle');
  if (idle) { const mixer = new AnimationMixer(model); mixer.clipAction(idle).play(); mixer.setTime(0); }
  model.updateMatrixWorld(true);
  const headBone = model.getObjectByName('Neck3') as Bone;
  const earBones = [model.getObjectByName('Ear1R') as Bone, model.getObjectByName('Ear1L') as Bone];
  if (!headBone?.isBone || earBones.some(ear => !ear?.isBone)) { disposeScene(model); throw new Error('Fox model unavailable. Reload to try again.'); }
  const meshes: SkinnedMesh[] = []; model.traverse(object => { if (object instanceof SkinnedMesh) meshes.push(object); });
  const gradient = new DataTexture(new Uint8Array([110, 185, 255]), 3, 1, RedFormat);
  gradient.minFilter = gradient.magFilter = NearestFilter; gradient.generateMipmaps = false; gradient.needsUpdate = true;
  const originalMaterials = new Set<Material>();
  const deformation = new Matrix4(), weighted = new Matrix4(), boneMatrix = new Matrix4();
  for (const mesh of meshes) {
    mesh.skeleton.update();
    const source = mesh.material as MeshToonMaterial;
    originalMaterials.add(source);
    const material = source.name === 'Eyes' ? new MeshBasicMaterial({ color: '#382c28' }) : new MeshToonMaterial({ color: palette[source.name] || '#df9559', gradientMap: gradient });
    material.name = source.name;
    material.userData.outlineParameters = source.name === 'Eyes' ? { visible: false } : { thickness: .0012, color: [.17, .12, .1] };
    mesh.material = material;

    // Add expression morphs in the artist's neutral world coordinates, then transform
    // them back through the bind matrices so they continue to follow the native rig.
    const positions = mesh.geometry.getAttribute('position');
    const joints = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    const channels = ['blinkLeft', 'blinkRight', 'gazeX', 'gazeY', 'mouth', 'smileLeft', 'smileRight', 'browLeft', 'browRight'];
    const morphs = channels.map(() => new Float32Array(positions.count * 3));
    for (let i = 0; i < positions.count; i++) {
      weighted.elements.fill(0);
      for (let component = 0; component < 4; component++) {
        boneMatrix.fromArray(mesh.skeleton.boneMatrices!, joints.getComponent(i, component) * 16);
        const weight = weights.getComponent(i, component);
        for (let element = 0; element < 16; element++) weighted.elements[element] += boneMatrix.elements[element] * weight;
      }
      deformation.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(weighted).multiply(mesh.bindMatrix);
      vertex.fromBufferAttribute(positions, i).applyMatrix4(deformation);
      const inverse = deformation.clone().invert();
      const eye = source.name === 'Eyes';
      const side = vertex.x > 0 ? 'Left' : 'Right';
      const face = clamp((vertex.z - 2.0) / .3) * clamp((vertex.y - 1.7) / .2);
      // Shorten the muzzle a little; keep the fox's original nose, cheeks and fur.
      const compactZ = vertex.z > 2.25 ? 2.25 + (vertex.z - 2.25) * .7 : vertex.z;
      const base = new Vector3(vertex.x, vertex.y, compactZ);
      const original = new Vector3().fromBufferAttribute(positions, i);
      positions.setXYZ(i, ...base.clone().applyMatrix4(inverse).toArray() as [number, number, number]);
      channels.forEach((channel, index) => {
        target.copy(base);
        if (eye && channel === `blink${side}`) target.y = 2.15 - Math.sin(clamp((Math.abs(base.x) - .202) / .062) * Math.PI) * .014 + (base.y - 2.15) * .015;
        if (eye && channel === 'gazeX') target.x -= .018;
        if (eye && channel === 'gazeY') target.y += .014;
        if (!eye && source.name !== 'Black' && channel === 'mouth') {
          const jaw = face * clamp((2.06 - vertex.y) / .13);
          target.y -= jaw * .09;
        }
        if (!eye && source.name !== 'Black' && channel === `smile${side}`) {
          const corner = face * clamp(Math.abs(vertex.x) / .18) * clamp((2.16 - vertex.y) / .16);
          target.y += corner * .042;
        }
        if (channel === `brow${side}`) {
          const brow = clamp(1 - Math.abs(vertex.y - 2.23) / .12) * clamp(1 - Math.abs(Math.abs(vertex.x) - .22) / .15) * face;
          target.y += brow * .032;
        }
        target.applyMatrix4(inverse).sub(base.clone().applyMatrix4(inverse));
        morphs[index].set(target.toArray(), i * 3);
      });
      // Preserve untouched geometry outside the muzzle while keeping the same mesh.
      if (!face && !eye) positions.setXYZ(i, original.x, original.y, original.z);
    }
    mesh.geometry.morphTargetsRelative = true;
    mesh.geometry.morphAttributes.position = morphs.map((data, i) => { const attribute = new BufferAttribute(data, 3); attribute.name = channels[i]; return attribute; });
    positions.needsUpdate = true; mesh.updateMorphTargets(); mesh.frustumCulled = false;
  }
  originalMaterials.forEach(material => material.dispose());
  const ears = earBones.map(bone => ({ bone, rest: bone.quaternion.clone().normalize() }));
  // Rotate about the face, keeping the animal's long neck from magnifying pitch.
  const head = new Group(); head.position.set(0, 2.16, 2.19); model.add(head); head.attach(headBone);
  // Small glints and curved sleeping lids sit on the original animal eyes.
  const ink = new MeshBasicMaterial({ color: '#382c28' }), shine = new MeshBasicMaterial({ color: '#fff7e6' });
  const pink = new MeshBasicMaterial({ color: '#e7a19a' });
  const fur = new MeshToonMaterial({ color: palette.Main, gradientMap: gradient });
  for (const material of [ink, shine, fur, pink]) material.userData.outlineParameters = { visible: false };
  const facial = new Group(); headBone.add(facial);
  const toHead = model.getObjectByName('Neck3')!.matrixWorld.clone().invert();
  const addAt = (object: Object3D, x: number, y: number, z: number) => { object.position.copy(new Vector3(x, y, z).applyMatrix4(toHead)); facial.add(object); };
  const eyeDetails = [-1, 1].map(side => {
    const curve = new CatmullRomCurve3([[side * .19, 2.15, 2.264], [side * .224, 2.13, 2.236], [side * .261, 2.15, 2.18]].map(([x, y, z]) => new Vector3(x, y, z).applyMatrix4(toHead)));
    const lid = new Mesh(new TubeGeometry(curve, 12, .00007, 5, false), ink); facial.add(lid);
    const eye = new Group(); addAt(eye, side * .236, 2.16, 2.218);
    eye.quaternion.copy(headBone.getWorldQuaternion(new Quaternion()).invert()); eye.scale.setScalar(.01);
    eye.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), side * .97));
    const pupil = new Mesh(new CircleGeometry(1, 32), ink); pupil.scale.set(.063, .065, .0025); eye.add(pupil);
    const glint = new Mesh(new CircleGeometry(1, 16), shine); glint.position.set(-side * .02, .026, .001); glint.scale.set(.008, .01, .001); eye.add(glint);
    const closed = new Mesh(new CircleGeometry(1, 32), fur); closed.position.copy(eye.position); closed.quaternion.copy(eye.quaternion); closed.position.add(new Vector3(0, 0, -.000035).applyQuaternion(eye.quaternion)); closed.scale.set(.00078, .00075, .01); facial.add(closed);
    return { lid, eye, pupil, glint, closed };
  });
  const mouth = new Group();
  addAt(mouth, 0, 1.835, 2.53);
  // Attach in world orientation despite the FBX skeleton's rotated bone axes.
  mouth.quaternion.copy(headBone.getWorldQuaternion(new Quaternion()).invert());
  mouth.scale.setScalar(.01);
  const opening = new Mesh(new SphereGeometry(1, 20, 12), ink); mouth.add(opening);
  const tongue = new Mesh(new CircleGeometry(1, 24), pink); mouth.add(tongue);
  const lips = [-1, 1].map(side => {
    const points = [[0, .025, .003], [side * .025, -.009, .008], [side * .065, .015, -.008]].map(([x, y, z]) => new Vector3(x, y, z));
    const lip = new Mesh(new TubeGeometry(new CatmullRomCurve3(points), 12, .0035, 5, false), ink); mouth.add(lip); return lip;
  });
  model.scale.setScalar(2.8); model.position.set(0, -2.23 * 2.8 + 1.45, -2.1 * 2.8); torso.add(model);
  headBone.scale.multiplyScalar(1.08);
  const snooze = new Group(); root.add(snooze);
  const letter = new Shape();
  [[0, 0], [.14, 0], [.14, .032], [.048, .032], [.14, .132], [.14, .16], [0, .16], [0, .128], [.092, .128], [0, .028]].forEach(([x, y], i) => i ? letter.lineTo(x, y) : letter.moveTo(x, y));
  letter.closePath();
  const letterGeometry = new ExtrudeGeometry(letter, { depth: .022, bevelEnabled: true, bevelSize: .004, bevelThickness: .004, bevelSegments: 2, steps: 1 });
  const sleepSymbols = [0, 1, 2].map(() => {
    const material = new MeshToonMaterial({ color: '#a3907b', gradientMap: gradient, transparent: true, depthWrite: false });
    material.userData.outlineParameters = { visible: false };
    const symbol = new Mesh(letterGeometry, material); snooze.add(symbol); return symbol;
  });
  root.updateMatrixWorld(true);
  const headRestWorld = head.getWorldQuaternion(new Quaternion());
  return { root, torso, head, headBone, model, meshes, gradient, ears, eyeDetails, mouth, opening, tongue, lips, headRestWorld, snooze, sleepSymbols };
}
export type FoxRig = ReturnType<typeof createFoxRig>;

// Close fully within a natural blink, including a short blink between camera samples.
const eyeClosure = (blink: number) => { const t = clamp(blink / .76); return t * t * (3 - 2 * t); };

export function animateFox(rig: FoxRig, frame: AvatarFrame, time = 0, reducedMotion = false) {
  // Match the mirrored head/torso: swap anatomical sides and reflect horizontal gaze
  // once, at the renderer boundary. Keep tracking and recentering in camera coordinates.
  frame = {
    ...frame, blinkLeft: frame.blinkRight, blinkRight: frame.blinkLeft,
    squintLeft: frame.squintRight, squintRight: frame.squintLeft,
    browLeft: frame.browRight, browRight: frame.browLeft,
    smileLeft: frame.smileRight, smileRight: frame.smileLeft, gazeX: -frame.gazeX,
  };
  rig.root.position.y = frame.breath;
  rig.torso.rotation.set(frame.torsoPitch, -frame.torsoYaw, -frame.torsoRoll, 'YXZ');
  rig.torso.scale.y = 1 + frame.breath * .6;
  rig.root.updateMatrixWorld(true);
  worldHead.setFromEuler(headEuler.set(frame.pitch, -frame.yaw, -frame.roll, 'YXZ')).multiply(rig.headRestWorld);
  rig.head.parent!.getWorldQuaternion(parentRotation);
  rig.head.quaternion.copy(parentRotation.invert().multiply(worldHead));
  for (const mesh of rig.meshes) {
    if (mesh.material instanceof Material && mesh.material.name === 'Eyes') mesh.visible = false;
    const dictionary = mesh.morphTargetDictionary!;
    for (const [name, index] of Object.entries(dictionary)) {
      let value = frame[name as keyof AvatarFrame] || 0;
      if (name === 'blinkLeft') value = clamp(eyeClosure(frame.blinkLeft) + frame.squintLeft * .45);
      if (name === 'blinkRight') value = clamp(eyeClosure(frame.blinkRight) + frame.squintRight * .45);
      mesh.morphTargetInfluences![index] = value;
    }
  }
  rig.eyeDetails.forEach((eye, i) => {
    const blink = eyeClosure(i === 0 ? frame.blinkRight : frame.blinkLeft);
    const brow = i === 0 ? frame.browRight : frame.browLeft;
    const smile = i === 0 ? frame.smileRight : frame.smileLeft;
    const squint = i === 0 ? frame.squintRight : frame.squintLeft;
    eye.closed.visible = true;
    eye.lid.visible = blink >= .9; eye.eye.visible = blink < .9; eye.glint.visible = blink < .6;
    eye.pupil.scale.y = .065 * Math.max(.015, (1 - blink) * (1 + brow * .18) * (1 - squint * .55 - smile * .15));
    eye.pupil.position.x = -frame.gazeX * .018; eye.pupil.position.y = frame.gazeY * .014 + brow * .007;
    eye.glint.position.y = .026 * (1 - blink);
  });
  rig.snooze.visible = !reducedMotion && frame.earDrop > .001;
  rig.sleepSymbols.forEach((symbol, i) => {
    const phase = ((time / 3500 + i / 3) % 1 + 1) % 1;
    symbol.position.set(1.8 + phase * .6, .25 + phase * .85, .65);
    symbol.rotation.set(0, -.18, -.1 + phase * .12);
    symbol.scale.setScalar(.8 + phase * .6);
    symbol.material.opacity = Math.sin(phase * Math.PI) * .72 * clamp(frame.earDrop);
  });
  rig.ears.forEach(({ bone, rest }, i) => {
    const brow = i === 0 ? frame.browRight : frame.browLeft;
    const perk = (1 - frame.earDrop) * (brow * .065 + frame.smile * .035);
    bone.quaternion.copy(rest).multiply(new Quaternion().setFromEuler(new Euler(-frame.earDrop * .28 + perk, 0, (i === 0 ? 1 : -1) * frame.earDrop * .15)));
  });
  const open = clamp(frame.mouth), smile = clamp(frame.smile);
  const mouthOpen = open > .045;
  const width = .06 + smile * .035, height = .003 + open * .075;
  rig.opening.visible = mouthOpen;
  rig.opening.scale.set(width, height, .015);
  rig.opening.position.y = -open * .024;
  rig.tongue.visible = open > .18;
  rig.tongue.scale.set(width * .48, height * .25, 1);
  rig.tongue.position.set(0, rig.opening.position.y - height * .5, .0155);
  rig.lips.forEach((lip, i) => {
    lip.visible = !mouthOpen;
    lip.rotation.z = (i === 0 ? -1 : 1) * (i === 0 ? frame.smileRight : frame.smileLeft) * .45;
    lip.position.y = 0;
  });
}

/** Dispose shared GPU resources once, including morph textures and the toon texture. */
export function disposeScene(root: Object3D) {
  const geometries = new Set<Mesh['geometry']>(), materials = new Set<Material>(), textures = new Set<Texture>(), skeletons = new Set<SkinnedMesh['skeleton']>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  skeletons.forEach(skeleton => skeleton.dispose()); textures.forEach(resource => resource.dispose());
  geometries.forEach(resource => resource.dispose()); materials.forEach(resource => resource.dispose());
}

export class FoxRenderer {
  readonly ready: Promise<void>;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-3.38, 3.38, 1.9, -1.9, .1, 30);
  private rig?: FoxRig;
  private animator = new AvatarAnimator();
  private outline: OutlineEffect;
  private outlineMaterials = new Set<Material>();
  private disposed = false;
  private loading = new AbortController();

  constructor(private canvas: HTMLCanvasElement, size = { width: 1280, height: 720 }) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1); this.renderer.setSize(size.width, size.height, false);
    this.renderer.outputColorSpace = SRGBColorSpace; this.renderer.toneMapping = NoToneMapping;
    this.outline = new OutlineEffect(this.renderer, { defaultThickness: .0012, defaultColor: [.17, .12, .1], defaultKeepAlive: true });
    this.camera.position.set(0, 0, 8); this.camera.lookAt(0, 0, 0);
    this.scene.add(new HemisphereLight('#fff6e7', '#80738d', 1.1));
    const key = new DirectionalLight('#ffffff', 2); key.position.set(-3, 5, 6); this.scene.add(key);
    this.ready = this.load();
    this.scene.onBeforeRender = () => this.scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof ShaderMaterial && 'outlineThickness' in material.uniforms) this.outlineMaterials.add(material);
      }
    });
  }
  private async load() {
    try {
      const response = await fetch('/models/quaternius-fox.glb', { signal: this.loading.signal });
      if (!response.ok) throw new Error('Model download failed');
      const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
      if (this.disposed) { disposeScene(gltf.scene); return; }
      this.rig = createFoxRig(gltf); this.scene.add(this.rig.root);
      this.canvas.dataset.model = 'quaternius-fox';
    } catch (error) { if (!this.disposed) throw error; }
  }
  draw(pose: Pose, time: number, background: Background, connected: boolean, reducedMotion: boolean) {
    if (this.disposed) return;
    this.scene.background = new Color(backgrounds.find(bg => bg.id === background)!.color);
    const frame = this.animator.tick(pose, time, connected, reducedMotion);
    if (this.rig) animateFox(this.rig, frame, time, reducedMotion);
    this.canvas.dataset.avatarState = this.animator.state;
    this.outline.render(this.scene, this.camera);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.loading.abort(); disposeScene(this.scene);
    this.outlineMaterials.forEach(material => material.dispose()); this.outlineMaterials.clear();
    this.scene.onBeforeRender = () => {}; this.renderer.dispose();
  }
}
