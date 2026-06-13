import { Mesh, MeshBuilder, StandardMaterial, Color3, TransformNode } from "@babylonjs/core";
import type { FreeCamera, Scene } from "@babylonjs/core";

type TransmitterPhase = "away" | "raising" | "arming" | "lowering";

const RAISE_TIME = 0.22;
const ARM_TIME = 0.52;
const LOWER_TIME = 0.24;

// A quick handheld call-in controller: it rises into frame, the thumb presses
// the transmit button, then it drops away as the Apache starts its run-in.
export class ApacheTransmitter {
  private root: TransformNode;
  private button: TransformNode;
  private phase: TransmitterPhase = "away";
  private phaseT = 0;
  private signalSent = false;

  constructor(scene: Scene, camera: FreeCamera) {
    const casing = new StandardMaterial("apacheTxCasingMat", scene);
    casing.diffuseColor = new Color3(0.09, 0.11, 0.09);
    casing.specularColor = new Color3(0.06, 0.06, 0.05);
    const rubber = new StandardMaterial("apacheTxRubberMat", scene);
    rubber.diffuseColor = new Color3(0.025, 0.028, 0.026);
    rubber.specularColor = Color3.Black();
    const amber = new StandardMaterial("apacheTxAmberMat", scene);
    amber.diffuseColor = new Color3(0.8, 0.48, 0.08);
    amber.emissiveColor = new Color3(0.28, 0.13, 0.02);
    amber.specularColor = Color3.Black();
    const skin = new StandardMaterial("apacheTxHandMat", scene);
    skin.diffuseColor = new Color3(0.56, 0.38, 0.27);
    skin.specularColor = new Color3(0.05, 0.035, 0.025);

    this.root = new TransformNode("apacheTransmitter", scene);
    this.root.parent = camera;
    this.root.rotation.set(0.28, -0.18, 0.06);
    this.root.setEnabled(false);

    const piece = (m: Mesh, mat: StandardMaterial, parent: TransformNode, x: number, y: number, z: number): Mesh => {
      m.material = mat;
      m.parent = parent;
      m.position.set(x, y, z);
      m.isPickable = false;
      return m;
    };

    piece(MeshBuilder.CreateBox("apacheTxBody", { width: 0.2, height: 0.3, depth: 0.075 }, scene), casing, this.root, 0.04, 0.02, 0);
    piece(MeshBuilder.CreateBox("apacheTxGrip", { width: 0.16, height: 0.16, depth: 0.09 }, scene), rubber, this.root, 0.04, -0.18, 0);
    piece(MeshBuilder.CreateBox("apacheTxScreen", { width: 0.13, height: 0.06, depth: 0.008 }, scene), amber, this.root, 0.04, 0.09, -0.042);
    const antenna = MeshBuilder.CreateCylinder("apacheTxAntenna", { diameter: 0.012, height: 0.33, tessellation: 8 }, scene);
    piece(antenna, rubber, this.root, 0.12, 0.28, 0);
    antenna.rotation.z = -0.22;

    this.button = new TransformNode("apacheTxButton", scene);
    this.button.parent = this.root;
    piece(MeshBuilder.CreateCylinder("apacheTxButtonCap", { diameter: 0.055, height: 0.018, tessellation: 14 }, scene), amber, this.button, 0, 0, -0.045);
    this.button.position.set(-0.03, -0.02, 0);
    this.button.rotation.x = Math.PI / 2;

    // Minimal hand silhouette: a palm behind the unit and a thumb over the
    // button. Enough motion to read as "pressed by hand" without building a
    // full second set of arms.
    piece(MeshBuilder.CreateBox("apacheTxPalm", { width: 0.23, height: 0.13, depth: 0.1 }, scene), skin, this.root, -0.04, -0.18, 0.035);
    const thumb = MeshBuilder.CreateCapsule("apacheTxThumb", {
      radius: 0.022,
      height: 0.17,
      tessellation: 8,
      capSubdivisions: 3,
    }, scene);
    piece(thumb, skin, this.button, -0.035, 0.006, -0.01);
    thumb.rotation.z = 1.1;
  }

  public get isOut(): boolean {
    return this.phase !== "away";
  }

  public open(): void {
    if (this.phase !== "away") return;
    this.phase = "raising";
    this.phaseT = 0;
    this.signalSent = false;
    this.root.setEnabled(true);
  }

  public forceClose(): void {
    this.phase = "away";
    this.phaseT = 0;
    this.signalSent = false;
    this.root.setEnabled(false);
  }

  // Returns true once, on the frame the transmitter sends the call-in signal.
  public update(dt: number): boolean {
    if (this.phase === "away") return false;

    this.phaseT += dt;
    let hold = 0;
    let sent = false;

    if (this.phase === "raising") {
      const t = Math.min(1, this.phaseT / RAISE_TIME);
      const s = t * t * (3 - 2 * t);
      this.root.position.set(0.18 - s * 0.06, -0.56 + s * 0.33, 0.48);
      if (this.phaseT >= RAISE_TIME) {
        this.phase = "arming";
        this.phaseT = 0;
      }
    } else if (this.phase === "arming") {
      hold = Math.sin(Math.min(1, this.phaseT / ARM_TIME) * Math.PI);
      if (!this.signalSent && this.phaseT >= ARM_TIME * 0.48) {
        this.signalSent = true;
        sent = true;
      }
      if (this.phaseT >= ARM_TIME) {
        this.phase = "lowering";
        this.phaseT = 0;
      }
    } else {
      const t = Math.min(1, this.phaseT / LOWER_TIME);
      const s = t * t * (3 - 2 * t);
      this.root.position.set(0.12 + s * 0.04, -0.23 - s * 0.34, 0.48);
      if (this.phaseT >= LOWER_TIME) {
        this.forceClose();
      }
    }

    this.button.position.z = -0.01 * hold;
    this.root.rotation.z = 0.06 + Math.sin(this.phaseT * 18) * 0.006;
    return sent;
  }
}
