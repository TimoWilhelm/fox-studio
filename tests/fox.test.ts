import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, Euler, Mesh, Quaternion, SkinnedMesh, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { animateFox, createFoxRig, disposeScene } from '../src/client/fox';
import { mapFace, neutralPose, type Pose } from '../src/shared/expression';
import { type AvatarFrame } from '../src/shared/animation';
const frame = (pose: Partial<Pose> = {}): AvatarFrame => ({ ...neutralPose(), ...pose, torsoYaw: 0, torsoPitch: 0, torsoRoll: 0, earDrop: 0, breath: 0 });
let modelBytes: ArrayBuffer;
beforeAll(async () => { const buffer = await readFile(new URL('../public/models/quaternius-fox.glb', import.meta.url)); modelBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); });
const load = async () => createFoxRig(await new GLTFLoader().parseAsync(modelBytes.slice(0), ''));

describe('Quaternius fox avatar', () => {
  it('loads the actual animal model and drives independent face channels', async () => {
    const rig = await load();
    expect(rig.meshes).toHaveLength(5);
    expect(rig.headBone.isBone).toBe(true);
    animateFox(rig, frame({ blinkLeft: 1, squintRight: .8, gazeX: .5, gazeY: -.4, mouth: .8, browLeft: .6, browRight: -.3, smileLeft: .9 }));
    expect(rig.eyeDetails[0].eye.visible).toBe(false);
    expect(rig.eyeDetails[0].lid.visible).toBe(true);
    expect(rig.eyeDetails[1].eye.visible).toBe(true);
    expect(rig.eyeDetails[1].pupil.scale.y).toBeLessThan(.04);
    expect(rig.eyeDetails[1].pupil.position.x).toBeGreaterThan(0);
    expect(rig.eyeDetails[1].pupil.position.y).toBeLessThan(0);
    const mesh = rig.meshes[0], dictionary = mesh.morphTargetDictionary!;
    expect(mesh.morphTargetInfluences![dictionary.browLeft]).toBeCloseTo(-.3);
    expect(mesh.morphTargetInfluences![dictionary.browRight]).toBeCloseTo(.6);
    expect(mesh.morphTargetInfluences![dictionary.smileLeft]).toBe(0);
    expect(mesh.morphTargetInfluences![dictionary.smileRight]).toBeCloseTo(.9);
    expect(rig.lips[0].rotation.z).toBeLessThan(0);
    expect(rig.lips[1].rotation.z).toBeCloseTo(0);
    expect(rig.opening.visible).toBe(true);
    expect(rig.opening.scale.y).toBeGreaterThan(.04);
    animateFox(rig, frame());
    expect(rig.opening.visible).toBe(false);
    expect(rig.eyeDetails[0].eye.visible).toBe(true);
    expect(mesh.morphTargetInfluences!.every(value => value === 0)).toBe(true);
    disposeScene(rig.root);
  });
  it('mirrors tracked winks, squints, brows and mouth corners onto the same screen side', async () => {
    const rig = await load();
    animateFox(rig, frame()); rig.root.updateMatrixWorld(true);
    expect(rig.eyeDetails[0].eye.getWorldPosition(new Vector3()).x).toBeLessThan(0);
    expect(rig.eyeDetails[1].eye.getWorldPosition(new Vector3()).x).toBeGreaterThan(0);
    for (const [side, index] of [['Left', 0], ['Right', 1]] as const) {
      const pose = mapFace({ coefficients: { [`eyeBlink${side}`]: 1, [`eyeSquint${side}`]: .8, [`browOuterUp${side}`]: .8, [`mouthSmile${side}`]: .8 }, matrix: [], timestamp: 0, found: true });
      const before = { ...pose };
      animateFox(rig, frame(pose));
      expect(rig.eyeDetails[index].lid.visible).toBe(true);
      expect(rig.eyeDetails[index].eye.visible).toBe(false);
      expect(rig.eyeDetails[1 - index].eye.visible).toBe(true);
      expect(Math.abs(rig.lips[index].rotation.z)).toBeGreaterThan(0);
      expect(rig.lips[1 - index].rotation.z).toBeCloseTo(0);
      const squint = { ...pose, blinkLeft: 0, blinkRight: 0, smileLeft: 0, smileRight: 0, browLeft: 0, browRight: 0 };
      animateFox(rig, frame(squint));
      expect(rig.eyeDetails[index].pupil.scale.y).toBeLessThan(rig.eyeDetails[1 - index].pupil.scale.y);
      animateFox(rig, frame({ ...pose, blinkLeft: 0, blinkRight: 0, squintLeft: 0, squintRight: 0, smileLeft: 0, smileRight: 0 }));
      expect(rig.eyeDetails[index].pupil.position.y).toBeGreaterThan(rig.eyeDetails[1 - index].pupil.position.y);
      expect(pose).toEqual(before);
    }
    disposeScene(rig.root);
  });
  it('mirrors horizontal gaze in world space without reversing vertical gaze', async () => {
    const rig = await load();
    animateFox(rig, frame()); rig.root.updateMatrixWorld(true);
    const neutral = rig.eyeDetails.map(eye => eye.pupil.getWorldPosition(new Vector3()));
    for (const direction of [-1, 1]) {
      const pose = mapFace({ coefficients: direction > 0 ? { eyeLookInLeft: .7, eyeLookOutRight: .7, eyeLookUpLeft: .6, eyeLookUpRight: .6 } : { eyeLookOutLeft: .7, eyeLookInRight: .7, eyeLookDownLeft: .6, eyeLookDownRight: .6 }, matrix: [], timestamp: 0, found: true });
      animateFox(rig, frame(pose)); rig.root.updateMatrixWorld(true);
      for (const [i, eye] of rig.eyeDetails.entries()) {
        const moved = eye.pupil.getWorldPosition(new Vector3()).sub(neutral[i]);
        expect(moved.x * direction).toBeGreaterThan(0);
        expect(moved.y * direction).toBeGreaterThan(0);
      }
    }
    disposeScene(rig.root);
  });
  it('closes a short blink completely without leaving a pupil under the lid', async () => {
    const rig = await load();
    animateFox(rig, frame({ blinkLeft: .2 }));
    expect(rig.eyeDetails[0].eye.visible).toBe(true);
    const partialHeight = rig.eyeDetails[0].pupil.scale.y;
    expect(partialHeight).toBeGreaterThan(0);
    expect(partialHeight).toBeLessThan(rig.eyeDetails[1].pupil.scale.y);
    animateFox(rig, frame({ blinkLeft: .65 }));
    expect(rig.eyeDetails[0].eye.visible).toBe(false);
    expect(rig.eyeDetails[0].lid.visible).toBe(true);
    expect(rig.eyeDetails[1].eye.visible).toBe(true);
    animateFox(rig, frame({ blinkRight: 1 }));
    expect(rig.eyeDetails[1].eye.visible).toBe(false);
    expect(rig.eyeDetails[0].eye.visible).toBe(true);
    disposeScene(rig.root);
  });
  it('uses one mouth shape at a time and restores the closed smile', async () => {
    const rig = await load();
    for (const mouth of [0, .02, .05, .2, .7, 1]) {
      animateFox(rig, frame({ mouth, smile: .8, smileLeft: 1 }));
      expect(rig.lips.every(lip => lip.visible === !rig.opening.visible)).toBe(true);
      expect(rig.tongue.visible && !rig.opening.visible).toBe(false);
    }
    animateFox(rig, frame({ smileLeft: 1 }));
    expect(rig.opening.visible).toBe(false);
    expect(rig.lips[0].visible).toBe(true);
    expect(rig.lips[0].rotation.z).toBeLessThan(0);
    disposeScene(rig.root);
  });
  it('animates 3D snooze symbols only while sleeping and respects reduced motion', async () => {
    const rig = await load();
    const asleep = { ...frame({ blinkLeft: 1, blinkRight: 1 }), earDrop: 1 };
    animateFox(rig, asleep, 1200);
    expect(rig.snooze.visible).toBe(true);
    expect(rig.sleepSymbols).toHaveLength(3);
    expect(rig.sleepSymbols.every(symbol => symbol.geometry.type === 'ExtrudeGeometry')).toBe(true);
    const positions = rig.sleepSymbols.map(symbol => symbol.position.clone());
    const opacity = rig.sleepSymbols[0].material.opacity;
    animateFox(rig, { ...asleep, earDrop: .5 }, 1200);
    expect(rig.sleepSymbols[0].material.opacity).toBeCloseTo(opacity / 2);
    animateFox(rig, asleep, 1500);
    expect(rig.sleepSymbols.every((symbol, i) => !symbol.position.equals(positions[i]))).toBe(true);
    animateFox(rig, asleep, 1500, true);
    expect(rig.snooze.visible).toBe(false);
    animateFox(rig, frame(), 1800);
    expect(rig.snooze.visible).toBe(false);
    disposeScene(rig.root);
  });
  it('compensates torso rotation while preserving native head orientation', async () => {
    const rig = await load();
    const pose = { ...frame({ yaw: .45, pitch: -.3, roll: .25 }), torsoYaw: .12, torsoPitch: -.06, torsoRoll: .09 };
    animateFox(rig, pose); rig.root.updateMatrixWorld(true);
    const expected = new Quaternion().setFromEuler(new Euler(pose.pitch, -pose.yaw, -pose.roll, 'YXZ')).multiply(rig.headRestWorld);
    expect(rig.head.getWorldQuaternion(new Quaternion()).angleTo(expected)).toBeLessThan(.00001);
    disposeScene(rig.root);
  });
  it('keeps facial landmarks inside the portrait over supported rotations', async () => {
    const rig = await load();
    for (const yaw of [-.6, 0, .6]) for (const pitch of [-.45, 0, .45]) for (const roll of [-.45, 0, .45]) {
      animateFox(rig, frame({ yaw, pitch, roll })); rig.root.updateMatrixWorld(true);
      const face = new Box3();
      for (const eye of rig.eyeDetails) face.expandByObject(eye.eye);
      face.expandByObject(rig.mouth);
      expect(face.max.y).toBeLessThan(1.9);
      expect(face.min.y).toBeGreaterThan(-1.9);
      expect(Math.max(Math.abs(face.min.x), Math.abs(face.max.x))).toBeLessThan(3.38);
    }
    disposeScene(rig.root);
  });
  it('closes the eyes and lowers the ears while sleeping, then restores their rest pose', async () => {
    const rig = await load(); const ears = rig.ears.map(ear => ear.rest.clone());
    animateFox(rig, { ...frame({ blinkLeft: 1, blinkRight: 1 }), earDrop: 1 });
    expect(rig.eyeDetails.every(eye => eye.lid.visible && !eye.eye.visible)).toBe(true);
    expect(rig.ears.every((ear, i) => ear.bone.quaternion.angleTo(ears[i]) > .1)).toBe(true);
    animateFox(rig, frame());
    expect(rig.ears.every((ear, i) => ear.bone.quaternion.angleTo(ears[i]) < .00001)).toBe(true);
    disposeScene(rig.root);
  });
  it('disposes all shared geometries, materials, skeletons and toon textures once', async () => {
    const rig = await load();
    expect(Array.from(rig.gradient.image.data)).toEqual([110, 185, 255]);
    const spies = new Map<object, ReturnType<typeof vi.spyOn>>();
    rig.root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const textures = materials.flatMap(material => Object.values(material).filter((value): value is Texture => value instanceof Texture));
      const resources = [object.geometry, ...materials, ...textures, ...(object instanceof SkinnedMesh ? [object.skeleton] : [])];
      for (const resource of resources) if (!spies.has(resource)) spies.set(resource, vi.spyOn(resource, 'dispose'));
    });
    expect(spies.has(rig.gradient)).toBe(true);
    disposeScene(rig.root);
    for (const spy of spies.values()) expect(spy).toHaveBeenCalledTimes(1);
  });
});
