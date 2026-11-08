"use client";
// WebGL 3D workspace: the campus, every team room and its agents. Same props as the SVG engine (IsoCampus).
import { TZ } from "../lib/tz";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "../lib/theme";
import { roomGeo, agentsOf, W3, ctrlFor, qpt, PLAZA, TREES, campusGrow, avatarFor, avatarSig, shapeOutline, SHAPE_TILT, SHAPE_EYE } from "./ControlCenter";

const P = PALETTE;
type Pick = { team: string; what?: string; member?: number };
const ease = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k * k * (3 - 2 * k));
const STATE_COL: Record<string, string> = { todo: P.warning, doing: P.accent, done: P.success };

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const c = cv.getContext("2d")!; draw(c);
  const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
  return tx;
}
function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function wrapLines(c: CanvasRenderingContext2D, text: string, maxW: number, maxL: number): string[] {
  const words = text.split(/\s+/); const out: string[] = []; let cur = "";
  for (const w of words) { const n = cur ? cur + " " + w : w; if (c.measureText(n).width > maxW && cur) { out.push(cur); cur = w; if (out.length >= maxL) break; } else cur = n; }
  if (out.length < maxL && cur) out.push(cur);
  if (out.length === maxL && words.join(" ").length > out.join(" ").length) out[maxL - 1] = out[maxL - 1].replace(/.{0,2}$/, "…");
  return out;
}

export default function Campus3D(props: any) {
  const host = useRef<HTMLDivElement>(null);
  const pr = useRef<any>(props); pr.current = props;
  const api = useRef<any>(null);
  const labelEls = useRef<Record<string, HTMLDivElement | null>>({});
  const [tip, setTip] = useState<{ p: Pick; x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);

  // data signature: rebuild rooms only when something visible in 3D changes
  const teams: any[] = props.teams;
  const sig = JSON.stringify(teams.map((t) => [t.id, t.status, t.members.length, t.tasks.map((k: any) => k.state + (k.owner || "")).join(","), (props.openOf || {})[t.id] || 0, t.activity.length ? t.activity[0].text : "", t.goal ? t.goal.current : null, avatarSig(t)]));

  useEffect(() => {
    const el = host.current; if (!el) return;
    let renderer: THREE.WebGLRenderer;
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 640 || /Android|iPhone|iPad/i.test(navigator.userAgent);
    try {
      const test = document.createElement("canvas");
      const ok = !!(test.getContext("webgl2") || test.getContext("webgl"));
      if (!ok) throw new Error("no webgl");
      renderer = new THREE.WebGLRenderer({ antialias: !mobile || window.devicePixelRatio < 2, powerPreference: "high-performance" });
    } catch (e) { pr.current.onFail && pr.current.onFail(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.6 : 2));
    renderer.shadowMap.enabled = !mobile;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    el.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); pr.current.onFail && pr.current.onFail(); });

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(P.page);
    scene.fog = new THREE.Fog(P.page, 38, 80);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x151515, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(-9, 18, -7);
    sun.castShadow = !mobile;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera; sc.left = -16; sc.right = 16; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 50;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc22576, 0.35); fill.position.set(10, 6, 12); scene.add(fill);

    // ---- shared materials ----
    const M = (color: string, o: any = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o });
    const mats = {
      ground: M(P.page, { roughness: 1 }), road: M("#1c1c1c", { roughness: 0.95 }), floor: M(P.card), floorF: M("#191919"),
      wall: M(P.control, { roughness: 0.9 }), wallTop: M(P.selected), desk: M(P.selected, { roughness: 0.6 }), dark: M("#101010", { roughness: 0.4 }),
      paper: M("#ececec", { roughness: 0.9 }), accent: M(P.accent, { roughness: 0.5 }), gold: M("#f5b82e", { roughness: 0.3, metalness: 0.6 }),
      leaf: M(P.blobs[1], { roughness: 0.75 }), leafD: M("#1f9c55", { roughness: 0.8 }), trunk: M("#4a3a2c"), pot: M("#3b3b3d"), eye: new THREE.MeshBasicMaterial({ color: 0x141414 }), shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      plaza: M(P.panel, { roughness: 0.9 }), tower: M(P.card, { roughness: 0.7 }),
    };
    const tileTex = canvasTex(128, 128, (c) => { c.fillStyle = P.card; c.fillRect(0, 0, 128, 128); c.strokeStyle = "#2a2a2a"; c.lineWidth = 3; c.strokeRect(0, 0, 128, 128); });
    tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
    const dashTex = canvasTex(64, 8, (c) => { c.fillStyle = "#1c1c1c"; c.fillRect(0, 0, 64, 8); c.fillStyle = "#3b3b3d"; c.fillRect(0, 3, 30, 2); });
    dashTex.wrapS = THREE.RepeatWrapping;
    const blobMats = P.blobs.map((c) => mobile ? M(c, { roughness: 0.35 }) : new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 }));
    const blobMatsSleep = P.blobs.map((c) => M(c, { roughness: 0.6, transparent: true, opacity: 0.55 }));
    const geo = {
      box: new THREE.BoxGeometry(1, 1, 1), sph: new THREE.SphereGeometry(1, 32, 20), sphLo: new THREE.SphereGeometry(1, 12, 8),
      cap: new THREE.CapsuleGeometry(0.17, 0.16, 8, 20), cyl: new THREE.CylinderGeometry(1, 1, 1, 24), cone4: new THREE.ConeGeometry(0.46, 0.62, 4, 1), cone: new THREE.ConeGeometry(1, 1, 6), ico: new THREE.IcosahedronGeometry(1, 1),
    };
    const boxGeo = geo.box.clone(); boxGeo.translate(0, 0.5, 0); // base at y=0 for scaling walls
    // ---- Grok avatars: a puffy extruded token per shape (unit size, centred) and a glossy material per colour ----
    const avGeo = (shape: string): THREE.BufferGeometry => {
      const k = "av_" + shape; if ((geo as any)[k]) return (geo as any)[k];
      const sh = new THREE.Shape();
      shapeOutline(shape as any).forEach((sg: any) => { if (sg[0] === "M") sh.moveTo(sg[1], sg[2]); else if (sg[0] === "L") sh.lineTo(sg[1], sg[2]); else sh.quadraticCurveTo(sg[1], sg[2], sg[3], sg[4]); });
      let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(sh, { depth: 0.55, bevelEnabled: true, bevelThickness: 0.42, bevelSize: 0.2, bevelSegments: 8, curveSegments: 12 });
      g.computeBoundingBox(); const bb = g.boundingBox!; g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
      g.scale(1 / (bb.max.x - bb.min.x), 1 / (bb.max.y - bb.min.y), 1 / (bb.max.z - bb.min.z));
      // weld the cap and bevel so the normals are smooth (a soft blob, not a faceted block)
      g.deleteAttribute("normal"); g.deleteAttribute("uv"); g = mergeVertices(g, 1e-4); g.computeVertexNormals();
      (geo as any)[k] = g; return g;
    };
    const avMats = new Map<string, THREE.Material>();
    const avMat = (color: string, sleep: boolean): THREE.Material => {
      const k = color + (sleep ? "z" : ""); let m = avMats.get(k);
      if (!m) { m = sleep ? M(color, { roughness: 0.6, transparent: true, opacity: 0.55 }) : mobile ? M(color, { roughness: 0.35 }) : new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 }); avMats.set(k, m); }
      return m;
    };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, shadow = true) => {
      const o = new THREE.Mesh(g, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); o.castShadow = shadow && !mobile; o.receiveShadow = !mobile; return o;
    };
    const sprite = (draw: (c: CanvasRenderingContext2D) => void, w: number, h: number, sx: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(w, h, draw), transparent: true, depthWrite: false }));
      s.scale.set(sx, (sx * h) / w, 1); return s;
    };

    // ---- static campus ----
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), mats.ground); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = !mobile; scene.add(ground);
    const grid = new THREE.GridHelper(60, 60, 0x1d1d1d, 0x1d1d1d); grid.position.y = 0.002; (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.7; scene.add(grid);
    const PL = W3(PLAZA);
    const plaza = new THREE.Group(); plaza.position.set(PL.x, 0, PL.z); scene.add(plaza);
    plaza.add(mesh(geo.cyl, mats.plaza, 1.5, 0.06, 1.5, 0, 0.03, 0, false));
    const ringMats: THREE.MeshBasicMaterial[] = [];
    const rings: THREE.Mesh[] = [0, 1, 2].map(() => { const m = new THREE.MeshBasicMaterial({ color: P.accent, transparent: true, opacity: 0.4, depthWrite: false }); ringMats.push(m); const r = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 48), m); r.rotation.x = -Math.PI / 2; r.position.y = 0.065; plaza.add(r); return r; });
    const tower = new THREE.Group(); plaza.add(tower);
    const pickClock = { clock: true };
    const tb = mesh(geo.box, mats.wallTop, 0.84, 0.22, 0.84, 0, 0.17, 0); tb.userData.pick = pickClock; tower.add(tb);
    const tt = mesh(geo.box, mats.tower, 0.52, 1.55, 0.52, 0, 1.05, 0); tt.userData.pick = pickClock; tower.add(tt);
    const roof = mesh(geo.cone4, mats.accent, 1, 1, 1, 0, 2.13, 0); roof.rotation.y = Math.PI / 4; roof.userData.pick = pickClock; tower.add(roof);
    const clockCv = document.createElement("canvas"); clockCv.width = clockCv.height = 128;
    const clockTex = new THREE.CanvasTexture(clockCv); clockTex.colorSpace = THREE.SRGBColorSpace;
    const drawClock = () => {
      const c = clockCv.getContext("2d")!; const d = new Date();
      c.clearRect(0, 0, 128, 128); c.fillStyle = P.page; c.beginPath(); c.arc(64, 64, 60, 0, 7); c.fill(); c.strokeStyle = P.selected; c.lineWidth = 6; c.stroke();
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as any).formatToParts(d);
      const hh = Number((parts.find((x) => x.type === "hour") || { value: "0" }).value), mm = Number((parts.find((x) => x.type === "minute") || { value: "0" }).value);
      const hand = (a: number, l: number, w: number, col: string) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = "round"; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + l * Math.sin(a), 64 - l * Math.cos(a)); c.stroke(); };
      for (let k = 0; k < 12; k++) { const a = (k * Math.PI) / 6; c.strokeStyle = P.text2; c.lineWidth = k % 3 ? 2 : 4; c.beginPath(); c.moveTo(64 + 48 * Math.sin(a), 64 - 48 * Math.cos(a)); c.lineTo(64 + 54 * Math.sin(a), 64 - 54 * Math.cos(a)); c.stroke(); }
      hand((((hh % 12) + mm / 60) * Math.PI) / 6, 28, 7, P.text); hand((mm * Math.PI) / 30, 42, 4, P.text); hand((d.getSeconds() * Math.PI) / 30, 46, 2, P.danger);
      clockTex.needsUpdate = true;
    };
    drawClock();
    const faceMat = new THREE.MeshBasicMaterial({ map: clockTex, transparent: true });
    for (let k = 0; k < 4; k++) { const f = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), faceMat); const a = (k * Math.PI) / 2; f.position.set(Math.sin(a) * 0.265, 1.45, Math.cos(a) * 0.265); f.rotation.y = a; f.userData.pick = pickClock; tower.add(f); }
    let soonBadge: THREE.Sprite | null = null;

    // roads (ribbons along the same curves as the 2D map)
    const roadGroup = new THREE.Group(); scene.add(roadGroup);
    const ribbon = (pts: { x: number; z: number }[], w: number, y: number, mat: THREE.Material) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = []; let len = 0;
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const n = Math.hypot(tx, tz) || 1; tx /= n; tz /= n;
        if (i > 0) len += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        pos.push(p.x - tz * w / 2, y, p.z + tx * w / 2, p.x + tz * w / 2, y, p.z - tx * w / 2);
        uv.push(len / 0.9, 0, len / 0.9, 1);
        if (i > 0) { const q = i * 2; idx.push(q - 2, q - 1, q, q - 1, q + 1, q); }
      });
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.receiveShadow = !mobile; return m;
    };
    const roadMat = new THREE.MeshStandardMaterial({ color: "#ffffff", map: dashTex, roughness: 0.95 });

    // trees
    const treeG = new THREE.Group(); scene.add(treeG);
    const trees: THREE.Group[] = [];
    TREES.forEach((q: any, i: number) => {
      const w = W3(q); const g = new THREE.Group(); g.position.set(w.x, 0, w.z);
      g.add(mesh(geo.cyl, mats.trunk, 0.07, 0.5, 0.07, 0, 0.25, 0));
      const s = 0.85 + ((i * 37) % 10) / 25;
      const c1 = mesh(geo.ico, mats.leaf, 0.42 * s, 0.4 * s, 0.42 * s, 0, 0.75 * s + 0.2, 0); g.add(c1);
      g.add(mesh(geo.ico, mats.leafD, 0.28 * s, 0.26 * s, 0.28 * s, 0.22 * s, 0.6 * s + 0.15, 0.1));
      treeG.add(g); trees.push(g);
    });

    // ---- rooms (rebuilt when the data changes) ----
    let rooms: any[] = [];
    let walkers: any[] = [];
    let pickables: THREE.Object3D[] = [tb, tt, roof, ...tower.children];
    const roomRoot = new THREE.Group(); scene.add(roomRoot);
    const disposeTree = (o: THREE.Object3D) => o.traverse((x: any) => { if (x.isMesh || x.isSprite) { if (x.geometry && !Object.values(geo).includes(x.geometry) && x.geometry !== boxGeo) x.geometry.dispose(); const ms = Array.isArray(x.material) ? x.material : [x.material]; ms.forEach((m: any) => { if (m && m.userData && m.userData.own) { if (m.map) m.map.dispose(); m.dispose(); } }); } });
    const own = <T extends THREE.Material>(m: T): T => { m.userData.own = true; return m; };

    const makeAgent = (a: any, seed: number) => {
      const g = new THREE.Group(); const body = new THREE.Group(); g.add(body);
      const sleep = a.state === "sleep";
      const av = a.name ? avatarFor(a.name) : null; // the bot's look in the Grok Bot app, when the data names one
      const mat = av ? avMat(av.color, sleep) : (sleep ? blobMatsSleep : blobMats)[a.ci % 6];
      const shape = Math.abs(seed) % 3; const S = a.lead ? 1.15 : 1;
      let b: THREE.Mesh;
      if (av && av.shape) {
        const ash = av.shape;
        if (ash === "circle") b = mesh(geo.sph, mat, 0.23 * S, 0.24 * S, 0.22 * S, 0, 0.24 * S, 0);
        else { b = mesh(avGeo(ash), mat, 0.43 * S, 0.43 * S, 0.3 * S, 0, 0.215 * S, 0); b.rotation.z = (SHAPE_TILT[ash] * Math.PI) / 180; }
        body.add(b);
        const topY = (ash === "circle" ? 0.48 : 0.44) * S, eyeY = (ash === "circle" ? 0.48 : 0.43) * S * SHAPE_EYE[ash] + 0.01, ez = (ash === "circle" ? 0.2 : 0.15) * S;
        return finishAgent(g, body, b, mat, a, seed, S, topY, eyeY, ez, sleep, av.badge);
      }
      if (shape === 0) b = mesh(geo.sph, mat, 0.22 * S, 0.25 * S, 0.21 * S, 0, 0.25 * S, 0);
      else if (shape === 1) b = mesh(geo.cap, mat, S, S, S, 0, 0.34 * S, 0);
      else { b = mesh(geo.sph, mat, 0.24 * S, 0.22 * S, 0.22 * S, 0, 0.23 * S, 0); const b2 = mesh(geo.sph, mat, 0.15 * S, 0.15 * S, 0.15 * S, 0.06 * S, 0.38 * S, 0); body.add(b2); }
      body.add(b);
      const topY = shape === 1 ? 0.67 * S : shape === 0 ? 0.5 * S : 0.53 * S;
      const eyeY = topY * 0.66, ez = shape === 1 ? 0.165 * S : 0.2 * S;
      return finishAgent(g, body, b, mat, a, seed, S, topY, eyeY, ez, sleep);
    };
    // eyes, hands, feet, crown, alert and z's: the same for every body shape
    const finishAgent = (g: THREE.Group, body: THREE.Group, b: THREE.Mesh, mat: THREE.Material, a: any, seed: number, S: number, topY: number, eyeY: number, ez: number, sleep: boolean, badge?: string) => {
      if (badge) body.add(mesh(geo.sph, avMat(badge, false), 0.075 * S, 0.075 * S, 0.06 * S, 0.17 * S, 0.13 * S, ez - 0.02, false));
      const eyes = new THREE.Group(); eyes.position.set(0, eyeY, ez); body.add(eyes);
      const mkEye = (x: number) => { const e = new THREE.Group(); e.position.x = x; const ball = mesh(geo.sphLo, mats.eye, 0.035 * S, 0.048 * S, 0.02 * S, 0, 0, 0, false); e.add(ball); const sh = mesh(geo.sphLo, mats.shine, 0.011 * S, 0.011 * S, 0.008 * S, 0.01 * S, 0.016 * S, 0.016 * S, false); e.add(sh); eyes.add(e); return e; };
      const eL = mkEye(-0.075 * S), eR = mkEye(0.075 * S);
      const hands = [mesh(geo.sphLo, mat, 0.055, 0.055, 0.055, -0.2 * S, 0.14, 0.12), mesh(geo.sphLo, mat, 0.055, 0.055, 0.055, 0.2 * S, 0.14, 0.12)];
      if (a.state === "type") hands.forEach((h) => body.add(h));
      const feet = [mesh(geo.sphLo, mat, 0.06, 0.04, 0.07, -0.08, 0.03, 0), mesh(geo.sphLo, mat, 0.06, 0.04, 0.07, 0.08, 0.03, 0)];
      if (a.state === "walk") feet.forEach((f) => g.add(f));
      if (a.lead && !sleep) {
        const crown = new THREE.Group(); crown.position.y = topY + 0.02;
        crown.add(mesh(geo.cyl, mats.gold, 0.09, 0.04, 0.09, 0, 0.02, 0, false));
        for (let k = 0; k < 5; k++) { const ang = (k / 5) * Math.PI * 2; crown.add(mesh(geo.cone, mats.gold, 0.025, 0.07, 0.025, Math.sin(ang) * 0.07, 0.07, Math.cos(ang) * 0.07, false)); }
        body.add(crown);
      }
      let alert: THREE.Sprite | null = null;
      if (a.alert) { alert = sprite((c) => { c.fillStyle = P.accent; c.beginPath(); c.arc(32, 32, 30, 0, 7); c.fill(); c.fillStyle = "#fff"; c.font = "bold 40px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("!", 32, 34); }, 64, 64, 0.2); alert.position.y = topY + 0.3; g.add(alert); }
      const zs: THREE.Sprite[] = [];
      if (sleep) for (let k = 0; k < 3; k++) { const z = sprite((c) => { c.fillStyle = P.text3; c.font = "bold 44px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("z", 32, 34); }, 64, 64, 0.09 + k * 0.03); g.add(z); zs.push(z); }
      if (sleep) { eL.scale.set(1.3, 0.15, 1); eR.scale.set(1.3, 0.15, 1); }
      return { g, body, eyes, eL, eR, hands, feet, alert, zs, a, seed, topY, base: b };
    };

    const build = () => {
      roomRoot.children.slice().forEach((c) => { roomRoot.remove(c); disposeTree(c); });
      roadGroup.children.slice().forEach((c) => { roadGroup.remove(c); disposeTree(c); });
      rooms = []; walkers = []; pickables = [tb, tt, roof, ...tower.children];
      const p0 = pr.current; const T: any[] = p0.teams;
      T.forEach((tm: any, ti: number) => {
        if (tm.status === "frozen") return;
        const p = p0.pos[tm.id]; if (!p) return;
        const c = ctrlFor(p); const pts: { x: number; z: number }[] = [];
        for (let i = 0; i <= 24; i++) pts.push(W3(qpt(PLAZA, c, p, i / 24)));
        roadGroup.add(ribbon(pts, 0.5, 0.004, roadMat));
        const per = 24 + ti * 2;
        const ag = makeAgent({ ci: (ti + 1) % 6, state: "walk", lead: false, alert: false }, ti * 3);
        ag.g.scale.setScalar(0.9);
        scene.add(ag.g); walkers.push({ ...ag, tm, p, c, per, i: ti });
      });
      T.forEach((tm: any) => {
        const p = p0.pos[tm.id]; if (!p) return;
        const idx = p0.idxOf[tm.id] || 0; const C = W3(p); const g = roomGeo(tm); const fz = tm.status === "frozen";
        const open = (p0.openOf || {})[tm.id] || 0;
        const G = new THREE.Group(); G.position.set(C.x, 0, C.z); roomRoot.add(G);
        const pick = (o: THREE.Object3D, what?: string, member?: number) => { o.userData.pick = { team: tm.id, what, member }; pickables.push(o); return o; };
        const floorMat = own(new THREE.MeshStandardMaterial({ color: "#ffffff", map: tileTex.clone(), roughness: 0.9 }));
        floorMat.map!.repeat.set(g.w / 0.55, g.d / 0.55); floorMat.map!.needsUpdate = true;
        if (fz) floorMat.color.set("#777777");
        const floor = mesh(geo.box, floorMat, g.w, 0.1, g.d, 0, 0.05, 0, false); pick(floor); G.add(floor);
        // outline (hover / focus)
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(g.w + 0.04, 0.11, g.d + 0.04)), own(new THREE.LineBasicMaterial({ color: P.accent, transparent: true, opacity: 0 })));
        edge.position.y = 0.055; G.add(edge);
        const freshRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), own(new THREE.MeshBasicMaterial({ color: P.accent, transparent: true, opacity: 0, depthWrite: false })));
        freshRing.rotation.x = -Math.PI / 2; freshRing.position.y = 0.01; freshRing.scale.set(g.w * 0.66, g.d * 0.72, 1); G.add(freshRing);
        // walls with cutaway
        const H = fz ? 0.8 : 1.05, WT = 0.08;
        const walls: any[] = [];
        const wall = (k: number, x: number, z: number, sx: number, sz: number) => {
          const m = new THREE.Mesh(boxGeo, mats.wall); m.scale.set(sx, H, sz); m.position.set(x, 0.1, z); m.castShadow = !mobile; m.receiveShadow = !mobile; pick(m); G.add(m);
          const cap = new THREE.Mesh(boxGeo, mats.wallTop); cap.scale.set(sx + 0.002, 0.02, sz + 0.002); cap.position.set(x, 0.1 + H, z); G.add(cap);
          walls.push({ k, m, cap, h: H });
        };
        wall(0, 0, -g.d / 2 + WT / 2, g.w, WT);
        wall(1, g.w / 2 - WT / 2, 0, WT, g.d);
        wall(3, -g.w / 2 + WT / 2, 0, WT, g.d);
        const gap = 0.84, seg = (g.w - gap) / 2;
        wall(2, -g.w / 2 + seg / 2, g.d / 2 - WT / 2, seg, WT);
        wall(2, g.w / 2 - seg / 2, g.d / 2 - WT / 2, seg, WT);
        // back-wall board + tv (canvas textures)
        const onWall: THREE.Object3D[] = [];
        if (!fz) {
          const bw = g.board.w, bh = 0.56;
          const btex = canvasTex(512, Math.round((512 * bh) / bw), (c) => {
            const W = c.canvas.width, Hh = c.canvas.height;
            c.fillStyle = "#151515"; c.fillRect(0, 0, W, Hh); c.strokeStyle = P.selected; c.lineWidth = 10; c.strokeRect(0, 0, W, Hh);
            (["todo", "doing", "done"] as const).forEach((st, col) => {
              const cw = (W - 30) / 3, x0 = W - 15 - (col + 1) * cw;
              const list = tm.tasks.filter((k: any) => k.state === st);
              c.fillStyle = STATE_COL[st]; c.font = `bold ${Math.round(Hh * 0.12)}px ${P.font}`; c.textAlign = "center"; c.direction = "ltr";
              c.fillText(`${st === "todo" ? "To do" : st === "doing" ? "In progress" : "Done"} · ${list.length}`, x0 + cw / 2, Hh * 0.2);
              list.slice(0, 6).forEach((_: any, j: number) => { const r = Math.floor(j / 2), q = j % 2; c.globalAlpha = st === "done" ? 0.55 : 0.95; c.fillStyle = STATE_COL[st]; rr(c, x0 + 8 + q * (cw / 2 - 4), Hh * 0.28 + r * Hh * 0.22, cw / 2 - 14, Hh * 0.17, 6); c.fill(); c.globalAlpha = 1; });
            });
          });
          const board = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), own(new THREE.MeshBasicMaterial({ map: btex })));
          board.position.set(g.board.x, 0.72, -g.d / 2 + WT + 0.006); pick(board, "task"); G.add(board); onWall.push(board);
          const tvw = g.tv.w, tvh = tvw * 0.56;
          const tvCv = document.createElement("canvas"); tvCv.width = 512; tvCv.height = 288;
          const tvTex = new THREE.CanvasTexture(tvCv); tvTex.colorSpace = THREE.SRGBColorSpace;
          const tvMat = own(new THREE.MeshBasicMaterial({ map: tvTex }));
          const tv = new THREE.Mesh(new THREE.PlaneGeometry(tvw, tvh), tvMat); tv.position.set(g.tv.x, 0.72, -g.d / 2 + WT + 0.014); pick(tv, "news"); G.add(tv); onWall.push(tv);
          const tvFrame = mesh(geo.box, mats.dark, tvw + 0.06, tvh + 0.06, 0.02, g.tv.x, 0.72, -g.d / 2 + WT + 0.001, false); G.add(tvFrame); onWall.push(tvFrame);
          const drawTv = (k: number) => {
            const c = tvCv.getContext("2d")!; const ev = tm.activity.length ? tm.activity[k % tm.activity.length] : null;
            c.fillStyle = "#0d0d0d"; c.fillRect(0, 0, 512, 288);
            c.fillStyle = P.accentSoft; c.fillRect(0, 0, 512, 60);
            c.fillStyle = P.danger; c.beginPath(); c.arc(480, 30, 10, 0, 7); c.fill();
            c.direction = "ltr"; c.textAlign = "right"; c.fillStyle = P.danger; c.font = `bold 30px ${P.font}`; c.fillText("LIVE", 458, 41);
            if (ev) {
              c.direction = "ltr"; c.textAlign = "left"; c.fillStyle = P.accentText; c.font = `bold 26px ${P.font}`; c.fillText(ev.time, 18, 40);
              c.direction = "ltr"; c.textAlign = "right"; c.fillStyle = P.text; c.font = `600 34px ${P.font}`;
              wrapLines(c, ev.text, 470, 4).forEach((l, i) => c.fillText(l, 490, 108 + i * 46));
            } else { c.direction = "ltr"; c.textAlign = "center"; c.fillStyle = P.text3; c.font = `30px ${P.font}`; c.fillText("Quiet here", 256, 170); }
            tvTex.needsUpdate = true;
          };
          drawTv(0);
          // shelf + trophy
          const shelf = mesh(geo.box, mats.wall, 0.36, 0.5, 0.36, -g.w / 2 + 0.3, 0.35, -g.d / 2 + 0.45); pick(shelf, "goal"); G.add(shelf);
          const done = tm.goal && tm.goal.current !== null && tm.goal.current >= tm.goal.target;
          const cup = mesh(geo.cyl, mats.gold, 0.08, 0.12, 0.08, -g.w / 2 + 0.3, 0.72, -g.d / 2 + 0.45); cup.scale.set(done ? 0.1 : 0.07, 0.12, done ? 0.1 : 0.07); pick(cup, "goal"); G.add(cup);
          G.add(mesh(geo.cyl, mats.gold, 0.03, 0.08, 0.03, -g.w / 2 + 0.3, 0.63, -g.d / 2 + 0.45));
          // plant
          G.add(mesh(geo.cyl, mats.pot, 0.12, 0.22, 0.12, g.w / 2 - 0.32, 0.21, g.d / 2 - 0.34));
          const leaves = mesh(geo.ico, mats.leaf, 0.2, 0.22, 0.2, g.w / 2 - 0.32, 0.48, g.d / 2 - 0.34); G.add(leaves);
          (G.userData as any).tv = { drawTv, n: tm.activity.length };
        }
        // desks, monitors, chairs
        const screens: THREE.Mesh[] = [];
        const desk = (x: number, z: number, wide: number, lead: boolean) => {
          const top = mesh(geo.box, mats.desk, wide, 0.05, 0.42, x, 0.42, z); pick(top, lead && open ? "inbox" : undefined); G.add(top);
          G.add(mesh(geo.box, mats.dark, wide - 0.08, 0.3, 0.36, x, 0.25, z + 0.01));
          G.add(mesh(geo.box, mats.dark, 0.3, 0.2, 0.025, x + wide / 2 - 0.22, 0.56, z - 0.02));
          G.add(mesh(geo.box, mats.dark, 0.04, 0.08, 0.04, x + wide / 2 - 0.22, 0.47, z - 0.02));
          const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.17), own(new THREE.MeshBasicMaterial({ color: fz ? "#222222" : P.blobs[(idx + (lead ? 0 : 2)) % 6], transparent: true, opacity: 0.85 })));
          scr.position.set(x + wide / 2 - 0.22, 0.56, z - 0.034); scr.rotation.y = Math.PI; G.add(scr); screens.push(scr);
          if (lead && open > 0) for (let k = 0; k < Math.min(6, open); k++) { const pp = mesh(geo.box, k === Math.min(6, open) - 1 ? mats.accent : mats.paper, 0.26, 0.022, 0.2, x - wide / 2 + 0.22 + (k % 2) * 0.012, 0.455 + k * 0.026, z + 0.03, false); pick(pp, "inbox"); G.add(pp); }
        };
        desk(g.lead.x, g.lead.z, 1.15, true);
        g.seats.forEach((s: any) => desk(s.x, s.z, Math.min(0.9, (g.w - 1) / Math.max(1, g.seats.length) - 0.12), false));
        // status lamp
        const lampMat = own(new THREE.MeshBasicMaterial({ color: P.success }));
        const lamp = new THREE.Mesh(geo.sphLo, lampMat); lamp.scale.setScalar(0.07); lamp.position.set(g.w / 2 - 0.14, H + 0.22, -g.d / 2 + 0.06); G.add(lamp);
        G.add(mesh(geo.cyl, mats.wallTop, 0.015, 0.12, 0.015, g.w / 2 - 0.14, H + 0.14, -g.d / 2 + 0.06, false));
        const glowMat = own(new THREE.SpriteMaterial({ map: canvasTex(64, 64, (c) => { const gr = c.createRadialGradient(32, 32, 2, 32, 32, 32); gr.addColorStop(0, "rgba(255,255,255,0.9)"); gr.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = gr; c.fillRect(0, 0, 64, 64); }), color: P.success, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        const glow = new THREE.Sprite(glowMat); glow.scale.setScalar(0.5); glow.position.copy(lamp.position); G.add(glow);
        // dim cover for the team filter
        const cover = new THREE.Mesh(geo.box, own(new THREE.MeshBasicMaterial({ color: P.page, transparent: true, opacity: 0, depthWrite: false })));
        cover.scale.set(g.w + 0.3, 1.9, g.d + 0.3); cover.position.y = 0.9; cover.visible = false; G.add(cover);
        // agents
        const ags = agentsOf(tm, idx, open).map((a: any, k: number) => {
          const A = makeAgent(a, idx * 7 + k); A.g.position.set(a.x, a.state === "sleep" ? 0.2 : 0.24, a.z - 0.1); A.g.scale.setScalar(1.12); G.add(A.g);
          G.add(mesh(geo.cyl, mats.dark, 0.13, 0.14, 0.13, a.x, 0.17, a.z - 0.1));
          A.g.traverse((o) => { if ((o as any).isMesh) { o.userData.pick = { team: tm.id, what: "person", member: a.i }; pickables.push(o); } });
          return A;
        });
        rooms.push({ tm, G, g, walls, onWall, edge, freshRing, lampMat, glowMat, lamp, glow, cover, ags, screens, idx, fz, anchor: new THREE.Vector3(C.x, H + 0.62, C.z - g.d / 2) });
      });
    };
    build();

    // ---- camera + controls ----
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.09; controls.screenSpacePanning = false;
    controls.minDistance = 3; controls.maxDistance = 55; controls.minPolarAngle = 0.2; controls.maxPolarAngle = 1.28;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.zoomSpeed = 0.9; controls.rotateSpeed = 0.6; controls.panSpeed = 1;
    let W = 1, Hh = 1;
    // free areas (px) the default view may use, e.g. between or below the HUD windows; the best one wins
    type Box = { l: number; r: number; t: number; b: number };
    const Z: Box = { l: 0, r: 0, t: 0, b: 0 };
    let boxes: Box[] = [Z], box: Box = Z, touched = false, homed0 = false;
    let shX = 0, shY = 0; // extra view shift (px) that centres the campus in the chosen free area
    const shiftOf = (_bx: Box) => ({ sx: offR / 2 + shX, sy: offB / 2 + shY });
    const homeIn = (bx: Box) => {
      const zero = bx.l + bx.r + bx.t + bx.b === 0;
      const fw = Math.max(120, W - offR - bx.l - bx.r), fh = Math.max(120, Hh - offB - bx.t - bx.b);
      const portrait = (zero ? Hh > W * 1.1 : fh > fw * 1.1);
      // default view (user-chosen): looking at the campus straight from the front, tilted ~55° down, on every viewport
      const az = 0, pol = 0.6;
      // frame every room: the original campus box, grown by any generated rooms (extra teams); unchanged for the 6 + 3 layout
      const gr = campusGrow(pr.current.teams, pr.current.pos);
      const tx = -0.7 + (gr.x1 - gr.x0) / 2, tz = 0.3 + (gr.z1 - gr.z0) / 2;
      const target = new THREE.Vector3(tx, 0, tz);
      const at = (dist: number) => new THREE.Vector3(tx + dist * Math.sin(pol) * Math.sin(az), dist * Math.cos(pol), tz + dist * Math.sin(pol) * Math.cos(az));
      const cam = camera.clone(); cam.clearViewOffset(); cam.aspect = W / Hh; cam.updateProjectionMatrix();
      const xs = [-11.6 - gr.x0, 10.2 + gr.x1];
      const corners: THREE.Vector3[] = [];
      xs.forEach((x) => [-6.9 - gr.z0, 7.3 + gr.z1].forEach((z) => [0, 1.6].forEach((y) => corners.push(new THREE.Vector3(x, y, z)))));
      const v = new THREE.Vector3();
      // 1) the original whole-screen fit
      let dist = 12;
      const lim = portrait ? 0.92 : 0.98, limY = portrait ? 0.62 : 0.9;
      for (let i = 0; i < 60; i++) {
        cam.position.copy(at(dist)); cam.lookAt(target); cam.updateMatrixWorld();
        const ok = corners.every((c) => { v.copy(c).project(cam); return Math.abs(v.x) < lim && v.y < limY && v.y > -0.95; });
        if (ok) break; dist *= 1.05;
      }
      if (zero) return { target, pos: at(Math.min(60, dist)), dist, box: bx, sx: 0, sy: 0 };
      // 2) scale it into the free box and centre it there
      const bbox = () => {
        cam.position.copy(at(dist)); cam.lookAt(target); cam.updateMatrixWorld();
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        corners.forEach((c) => { v.copy(c).project(cam); const px = (v.x + 1) / 2 * W, py = (1 - v.y) / 2 * Hh; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); });
        y0 -= 34; x0 -= 26; x1 += 18; // room labels float above the walls and stick out sideways
        return { x0, x1, y0, y1 };
      };
      for (let i = 0; i < 5; i++) { const q = bbox(); const f = Math.max((q.x1 - q.x0) / (fw * 0.985), (q.y1 - q.y0) / (fh * 0.97)); dist *= Math.max(0.4, Math.min(3, f)); }
      if (W < 640) dist /= 1.3; // phone / Fold cover screen: closer, so the rooms are not tiny (sides may crop a little)
      dist = Math.min(150, dist);
      const q = bbox();
      const sx = (q.x0 + q.x1) / 2 - (bx.l + fw / 2), sy = (q.y0 + q.y1) / 2 - (bx.t + fh / 2);
      return { target, pos: at(dist), dist, box: bx, sx, sy };
    };
    const homeOf = () => {
      // between the lists only when that gap is wide enough (>= 55% of the width); otherwise below them, full width
      const cand = boxes.length > 1 && W - boxes[0].l - boxes[0].r < W * 0.55 ? boxes.slice(1) : boxes;
      let best: ReturnType<typeof homeIn> | null = null; for (const bx of cand) { const h = homeIn(bx); if (!best || h.dist < best.dist) best = h; } return best as ReturnType<typeof homeIn>;
    };
    const resize = () => {
      const r = el.getBoundingClientRect(); W = Math.max(1, r.width); Hh = Math.max(1, r.height);
      renderer.setSize(W, Hh, false); renderer.domElement.style.width = W + "px"; renderer.domElement.style.height = Hh + "px";
      camera.aspect = W / Hh; applyOffset();
      if (homed0 && !touched && !saved && !fly) jumpHome();
    };
    let offR = 0, offB = 0;
    const applyOffset = () => {
      const sh = shiftOf(box);
      if (Math.abs(sh.sx) > 0.5 || Math.abs(sh.sy) > 0.5) camera.setViewOffset(W, Hh, sh.sx, sh.sy, W, Hh); else camera.clearViewOffset();
      camera.aspect = W / Hh; camera.updateProjectionMatrix();
    };
    resize();
    const jumpHome = () => { const h = homeOf(); controls.maxDistance = Math.max(55, h.dist * 1.3); box = h.box; shX = h.sx; shY = h.sy; applyOffset(); camera.position.copy(h.pos); controls.target.copy(h.target); controls.update(); };
    jumpHome(); homed0 = true;
    controls.addEventListener("start", () => { touched = true; });
    let fly: null | { p0: THREE.Vector3; t0v: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; s: number; d: number } = null;
    const flyTo = (pos: THREE.Vector3, target: THREE.Vector3, d = 0.95) => { fly = { p0: camera.position.clone(), t0v: controls.target.clone(), p1: pos, t1: target, s: performance.now() / 1000, d }; controls.enabled = false; };
    let saved: null | { pos: THREE.Vector3; target: THREE.Vector3 } = null;
    const roomView = (id: string) => {
      const R = rooms.find((r) => r.tm.id === id); if (!R) return null;
      const C = R.G.position; const target = new THREE.Vector3(C.x, 0.45, C.z + 0.1);
      const off = camera.position.clone().sub(controls.target); const az = Math.atan2(off.x, off.z);
      const pol = 0.9; const vis = Math.max(200, W - offR), vh = Math.max(200, Hh - offB);
      const tv = Math.tan((camera.fov * Math.PI) / 360);
      const hfov = 2 * Math.atan(tv * (vis / Hh)), vfov = 2 * Math.atan(tv * (vh / Hh));
      const ca = Math.abs(Math.cos(az)), sa = Math.abs(Math.sin(az));
      const extH = R.g.w * ca + R.g.d * sa + 0.9, extV = (R.g.w * sa + R.g.d * ca) * 0.72 + 1.3;
      const dist = Math.max(extH / 2 / Math.tan(hfov / 2), extV / 2 / Math.tan(vfov / 2)) * 1.1;
      return { target, pos: new THREE.Vector3(target.x + dist * Math.sin(pol) * Math.sin(az), target.y + dist * Math.cos(pol), target.z + dist * Math.sin(pol) * Math.cos(az)) };
    };
    const rotateBy = (da: number) => {
      const off = camera.position.clone().sub(controls.target); const s = new THREE.Spherical().setFromVector3(off); s.theta += da;
      flyTo(controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)), controls.target.clone(), 0.6);
    };
    const dollyBy = (f: number) => {
      const off = camera.position.clone().sub(controls.target); const len = Math.max(controls.minDistance, Math.min(controls.maxDistance, off.length() * f));
      flyTo(controls.target.clone().add(off.setLength(len)), controls.target.clone(), 0.35);
    };
    const tilt = () => { const off = camera.position.clone().sub(controls.target); const s = new THREE.Spherical().setFromVector3(off); s.phi = s.phi < 0.6 ? 0.95 : s.phi > 1.05 ? 0.45 : 1.2; flyTo(controls.target.clone().add(new THREE.Vector3().setFromSpherical(s)), controls.target.clone(), 0.6); };

    // ---- picking ----
    const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
    const pickAt = (cx: number, cy: number): any => {
      const r = renderer.domElement.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(pickables, false).find((h) => h.object.visible);
      return hit ? hit.object.userData.pick : null;
    };
    let down: null | { x: number; y: number; t: number } = null;
    let lastHover = "";
    let hoverT = 0;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; setTip(null); };
    const onUp = (e: PointerEvent) => {
      if (!down) return; const d = Math.hypot(e.clientX - down.x, e.clientY - down.y); const quick = performance.now() - down.t < 600; down = null;
      if (d > 7 || !quick) return;
      const p = pickAt(e.clientX, e.clientY); if (!p) return;
      if (p.clock) pr.current.onClock(); else { setTip(null); pr.current.onPick(p); }
    };
    const onMove = (e: PointerEvent) => {
      if (down || e.pointerType === "touch") return;
      const now = performance.now(); if (now - hoverT < 45) return; hoverT = now;
      const p = pickAt(e.clientX, e.clientY); const k = p ? JSON.stringify(p) : "";
      renderer.domElement.style.cursor = p ? "pointer" : "grab";
      const r = el.getBoundingClientRect();
      if (k !== lastHover) { lastHover = k; pr.current.onHot(p && !p.clock ? p.team : null); }
      setTip(p && !p.clock ? { p, x: e.clientX - r.left, y: e.clientY - r.top } : null);
    };
    const onLeave = () => { lastHover = ""; pr.current.onHot(null); setTip(null); };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    const ro = new ResizeObserver(resize); ro.observe(el);

    // ---- frame loop ----
    let raf = 0, last = 0, lastClock = 0, frame = 0;
    const camDir = new THREE.Vector3(); const tmpV = new THREE.Vector3();
    const loop = (ms: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (mobile && ms - last < 30) return;
      { const fd = camera.position.distanceTo(controls.target); const fg = scene.fog as THREE.Fog; fg.near = Math.max(38, fd + 6); fg.far = Math.max(80, fd + 44); }
      last = ms; frame++;
      const t = ms / 1000; const p = pr.current;
      // camera fly
      if (fly) {
        const k = ease((t - fly.s) / fly.d);
        camera.position.lerpVectors(fly.p0, fly.p1, k); controls.target.lerpVectors(fly.t0v, fly.t1, k);
        if (k >= 1) { fly = null; controls.enabled = true; }
      }
      controls.update();
      controls.target.x = Math.max(-13, Math.min(13, controls.target.x)); controls.target.z = Math.max(-9, Math.min(9, controls.target.z)); controls.target.y = Math.max(0, Math.min(2, controls.target.y));
      const off = camera.position.clone().sub(controls.target);
      p.view.current = { x: controls.target.x, z: controls.target.z, yaw: Math.atan2(off.x, off.z) };
      camera.getWorldDirection(camDir);
      // plaza
      rings.forEach((r, k) => { const ph = (t * 0.3 + k / 3) % 1; const s = 0.45 + ph * 1.0; r.scale.set(s, s, 1); ringMats[k].opacity = 0.5 * (1 - ph); });
      if (t - lastClock > 1) { lastClock = t; drawClock(); }
      if ((p.soonN || 0) > 0 && !soonBadge) { soonBadge = sprite((c) => { c.fillStyle = P.accent; c.beginPath(); c.arc(32, 32, 30, 0, 7); c.fill(); c.fillStyle = "#fff"; c.font = "bold 34px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(String(p.soonN), 32, 34); }, 64, 64, 0.32); soonBadge.position.set(0.32, 2.35, 0); tower.add(soonBadge); }
      if (soonBadge) soonBadge.position.y = 2.35 + Math.sin(t * 4) * 0.04;
      trees.forEach((g, i) => { g.rotation.z = Math.sin(t * 0.8 + i) * 0.025; });
      dashTex.offset.x = -t * 0.25;
      // rooms
      const camXZ = new THREE.Vector2(camera.position.x, camera.position.z);
      rooms.forEach((R) => {
        const C = R.G.position;
        const hot = p.hot === R.tm.id || p.focus === R.tm.id;
        (R.edge.material as THREE.LineBasicMaterial).opacity += ((hot ? 0.9 : 0) - (R.edge.material as THREE.LineBasicMaterial).opacity) * 0.2;
        const fr = (p.freshOf || {})[R.tm.id] || 0;
        const frm = R.freshRing.material as THREE.MeshBasicMaterial; const ph = (t * 0.7) % 1;
        frm.opacity = fr > 0 && !(p.dim && p.dim !== R.tm.id) ? 0.8 * (1 - ph) : 0; const fs = 1 + ph * 0.25; R.freshRing.scale.set(R.g.w * 0.66 * fs, R.g.d * 0.72 * fs, 1);
        const dimmed = !!p.dim && p.dim !== R.tm.id;
        const cm = R.cover.material as THREE.MeshBasicMaterial; cm.opacity += ((dimmed ? 0.72 : 0) - cm.opacity) * 0.15; R.cover.visible = cm.opacity > 0.01;
        // cutaway: walls between the camera and the room drop low
        const dx = camXZ.x - C.x, dz = camXZ.y - C.z;
        R.walls.forEach((w: any) => {
          const n = w.k === 0 ? [0, -1] : w.k === 1 ? [1, 0] : w.k === 2 ? [0, 1] : [-1, 0];
          const near = n[0] * dx + n[1] * dz > 0;
          const target = near ? 0.22 : w.h;
          const cur = w.m.scale.y; const nx = cur + (target - cur) * 0.18;
          w.m.scale.y = nx; w.cap.position.y = 0.1 + nx;
        });
        const northCut = -dz > 0;
        R.onWall.forEach((o: THREE.Object3D) => { o.visible = !northCut; });
        // status lamp
        const al = (p.alertsOf || {})[R.tm.id] || [];
        const col = R.fz ? "#555555" : al.length ? P.danger : R.tm.status === "hold" ? P.warning : R.tm.status === "partial" ? P.accentText : P.success;
        R.lampMat.color.set(col); R.glowMat.color.set(col); const pulse = R.fz ? 0.25 : 0.45 + 0.12 * Math.sin(t * 3 + R.idx) + (al.length ? 0.2 * Math.max(0, Math.sin(t * 7)) : 0); R.glow.scale.setScalar(pulse * 0.75);
        R.screens.forEach((s: THREE.Mesh, k: number) => { (s.material as THREE.MeshBasicMaterial).opacity = R.fz ? 0.5 : 0.65 + 0.25 * Math.sin(t * 3 + k * 1.3 + R.idx); });
        const tv = (R.G.userData as any).tv; if (tv && tv.n > 1) { const k = Math.floor((t + R.idx * 1.3) / 4.5); if (k !== tv.k) { tv.k = k; tv.drawTv(k); } }
        // agents
        R.ags.forEach((A: any) => {
          const a = A.a; const sd = A.seed;
          tmpV.copy(camera.position); R.G.worldToLocal(tmpV);
          const want = Math.atan2(tmpV.x - A.g.position.x, tmpV.z - A.g.position.z);
          let dy = want - A.g.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; A.g.rotation.y += dy * 0.08;
          if (a.state === "sleep") { A.body.scale.set(1.04, 0.86 + 0.02 * Math.sin(t * 0.8 + sd), 1.04); A.zs.forEach((z: THREE.Sprite, k: number) => { const ph = (t * 0.45 + k / 3 + sd * 0.1) % 1; z.position.set(0.14 + ph * 0.18, A.topY + 0.05 + ph * 0.4, 0); (z.material as THREE.SpriteMaterial).opacity = 1 - ph; }); return; }
          const typing = a.state === "type";
          A.body.position.y = typing ? Math.abs(Math.sin(t * 9 + sd)) * 0.012 : Math.max(0, Math.sin(t * 1.6 + sd)) * 0.02 + ((t + sd) % 9 < 0.35 ? Math.sin(((t + sd) % 9) / 0.35 * Math.PI) * 0.08 : 0);
          const br = 1 + 0.025 * Math.sin(t * 2.2 + sd); A.body.scale.set(1 / Math.sqrt(br), br, 1 / Math.sqrt(br));
          const blink = ((t + sd * 0.7) % 4.2) < 0.12; A.eL.scale.y = A.eR.scale.y = blink ? 0.12 : 1;
          const look = Math.sin(t * 0.7 + sd) * 0.018; A.eyes.position.x = look;
          if (typing) A.hands.forEach((h: THREE.Mesh, k: number) => { h.position.y = 0.14 + (Math.sin(t * 16 + sd * 2 + k * Math.PI) > 0 ? 0.02 : -0.01); });
          if (A.alert) { A.alert.position.y = A.topY + 0.3 + Math.abs(Math.sin(t * 3)) * 0.06; }
        });
      });
      // walkers along the roads
      walkers.forEach((w: any) => {
        const f = ((t + w.i * 5) % w.per) / w.per; let k = -1;
        if (f > 0.3 && f <= 0.48) k = 0.82 - ease((f - 0.3) / 0.18) * 0.62; else if (f > 0.48 && f <= 0.6) k = 0.2; else if (f > 0.6 && f <= 0.78) k = 0.2 + ease((f - 0.6) / 0.18) * 0.62;
        w.g.visible = k >= 0 && !(p.dim && p.dim !== w.tm.id);
        if (k < 0) return;
        const q = W3(qpt(PLAZA, w.c, w.p, k)), q2 = W3(qpt(PLAZA, w.c, w.p, Math.min(1, k + 0.01)));
        const dir = f <= 0.48 ? -1 : 1; const moving = !(f > 0.48 && f <= 0.6);
        w.g.position.set(q.x, (moving ? Math.abs(Math.sin(t * 10 + w.i)) * 0.04 : 0), q.z);
        w.g.rotation.y = Math.atan2((q2.x - q.x) * dir, (q2.z - q.z) * dir);
        w.feet.forEach((ft: THREE.Mesh, j: number) => { ft.position.z = moving ? Math.sin(t * 12 + j * Math.PI) * 0.05 : 0; });
        const bl = ((t + w.seed * 0.7) % 4.2) < 0.12; w.eL.scale.y = w.eR.scale.y = bl ? 0.12 : 1;
      });
      renderer.render(scene, camera);
      // labels follow their rooms
      const r = renderer.domElement;
      rooms.forEach((R) => {
        const lb = labelEls.current[R.tm.id]; if (!lb) return;
        tmpV.copy(R.anchor); tmpV.project(camera);
        const vis = tmpV.z < 1 && Math.abs(tmpV.x) < 1.3 && Math.abs(tmpV.y) < 1.3;
        const x = (tmpV.x * 0.5 + 0.5) * r.clientWidth, y = (-tmpV.y * 0.5 + 0.5) * r.clientHeight;
        lb.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        lb.style.opacity = vis ? (p.dim && p.dim !== R.tm.id ? "0.35" : p.focus && p.focus !== R.tm.id ? "0.25" : "1") : "0";
      });
      const FR = p.focus ? rooms.find((x) => x.tm.id === p.focus) : null;
      for (let k = 0; k < 12; k++) {
        const lb = labelEls.current["ag" + k]; if (!lb) continue;
        const A = FR && FR.ags[k];
        if (!A || fly) { lb.style.opacity = "0"; continue; }
        A.g.getWorldPosition(tmpV); tmpV.y -= 0.02; tmpV.project(camera);
        lb.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * r.clientWidth).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * r.clientHeight).toFixed(1)}px) translate(-50%, 4px)`;
        lb.style.opacity = tmpV.z < 1 ? "1" : "0";
      }
      const cl = labelEls.current["__clock"];
      if (cl) { tmpV.set(PL.x, 0, PL.z + 1.3); tmpV.project(camera); const dist = camera.position.distanceTo(controls.target); cl.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * r.clientWidth).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * r.clientHeight).toFixed(1)}px) translate(-50%, 0)`; cl.style.opacity = dist < 22 && !p.focus ? "1" : "0"; }
      if (frame === 2) setReady(true);
    };
    raf = requestAnimationFrame(loop);

    api.current = {
      rebuild: () => { build(); if (!touched && !saved && !fly) jumpHome(); },
      focus: (id: string | null, was: string | null) => {
        if (id) { if (!was) saved = { pos: camera.position.clone(), target: controls.target.clone() }; const v = roomView(id); if (v) flyTo(v.pos, v.target); }
        else if (saved) { flyTo(saved.pos, saved.target); saved = null; }
        else if (!touched) jumpHome();
      },
      cmd: (k: string) => {
        if (k === "home") { const h = homeOf(); controls.maxDistance = Math.max(55, h.dist * 1.3); box = h.box; shX = h.sx; shY = h.sy; applyOffset(); flyTo(h.pos, h.target); saved = null; touched = false; }
        else if (k === "in") dollyBy(1 / 1.35); else if (k === "out") dollyBy(1.35);
        else if (k === "left") rotateBy(-Math.PI / 4); else if (k === "right") rotateBy(Math.PI / 4); else if (k === "tilt") tilt();
      },
      pad: (r: number, b: number) => { offR = r; offB = b; applyOffset(); },
      fit: (bx: Box[] | undefined) => { boxes = bx && bx.length ? bx : [Z]; if (!touched && !saved && !fly) jumpHome(); },
    };
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      roomRoot.children.slice().forEach((c) => disposeTree(c));
      renderer.dispose(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      api.current = null;
    };
  }, []);

  useEffect(() => { if (api.current) api.current.rebuild(); }, [sig]);
  useEffect(() => { if (api.current) api.current.pad(props.padR || 0, props.padB || 0); }, [props.padR, props.padB, ready]);
  const fitKey = JSON.stringify(props.fitBoxes || null);
  useEffect(() => { if (api.current && api.current.fit) api.current.fit(props.fitBoxes); }, [fitKey, ready]);
  const lastFocus = useRef<string | null>(null);
  useEffect(() => { if (!api.current) return; const was = lastFocus.current; lastFocus.current = props.focus; api.current.focus(props.focus, was); }, [props.focus, ready]);
  const lastCmd = useRef(props.cmd.n);
  useEffect(() => { if (!api.current || props.cmd.n === lastCmd.current) return; lastCmd.current = props.cmd.n; api.current.cmd(props.cmd.kind); }, [props.cmd.n]);

  const tipEl = tip ? props.tip(tip.p) : null;
  const hostW = host.current ? host.current.clientWidth : 1200;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: P.page }}>
      <div ref={host} style={{ position: "absolute", inset: 0, opacity: ready ? 1 : 0, transition: "opacity 500ms" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {teams.map((tm) => {
          const fz = tm.status === "frozen"; const open = (props.openOf || {})[tm.id] || 0; const al = (props.alertsOf || {})[tm.id] || []; const fr = (props.freshOf || {})[tm.id] || 0;
          const tone = fz ? P.text3 : al.length ? P.danger : tm.status === "hold" ? P.warning : tm.status === "partial" ? P.accentText : P.success;
          return (
            <div key={tm.id} ref={(e) => { labelEls.current[tm.id] = e; }} onClick={() => props.onPick({ team: tm.id })} onPointerEnter={() => props.onHot(tm.id)} onPointerLeave={() => props.onHot(null)}
              style={{ position: "absolute", left: 0, top: 0, opacity: 0, display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 6px", borderRadius: 999, background: P.card, border: `1px solid ${props.hot === tm.id ? P.accent : P.control}`, color: fz ? P.text3 : P.text, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer", pointerEvents: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.35)", transition: "opacity 300ms", willChange: "transform" }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: tone }} />
              {tm.name}
              {open > 0 && <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: P.accent, color: "#fff", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>{open}</span>}
              {al.length > 0 && <span title={al.join(" · ")} style={{ fontSize: 12 }}>🚨</span>}
              {fr > 0 && <span style={{ fontSize: 10, fontWeight: 800, color: P.accentText }}>✦ {fr} new</span>}
            </div>
          );
        })}
        {(() => {
          const ft = props.focus ? teams.find((x) => x.id === props.focus) : null;
          if (!ft) return null;
          const ags = agentsOf(ft, props.idxOf[ft.id] || 0, (props.openOf || {})[ft.id] || 0);
          return ags.slice(0, 12).map((a: any, k: number) => (
            <div key={ft.id + k} ref={(e) => { labelEls.current["ag" + k] = e; }} onClick={() => props.onPick({ team: ft.id, what: "person", member: a.i })}
              style={{ position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "auto", cursor: "pointer", textAlign: "center", padding: "2px 8px", borderRadius: 10, background: "rgba(20,20,20,.78)", border: `1px solid ${P.control}`, maxWidth: 150, transition: "opacity 250ms" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: P.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.lead ? "👑 " : ""}{a.name}</div>
              {a.state === "type" && a.task && <div style={{ fontSize: 10.5, color: P.accentText, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>⌨ {a.task}</div>}
              {a.state === "sleep" && <div style={{ fontSize: 10.5, color: P.text3 }}>Asleep</div>}
            </div>
          ));
        })()}
        <div ref={(e) => { labelEls.current["__clock"] = e; }} style={{ position: "absolute", left: 0, top: 0, opacity: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "opacity 300ms" }}>
          {(props.clockLines || []).slice(0, 3).map((s: string, k: number) => <span key={k} style={{ fontSize: 12, padding: "2px 9px", borderRadius: 999, background: P.card, border: `1px solid ${k === 0 ? P.accent : P.divider}`, color: P.text, whiteSpace: "nowrap" }}>{s}</span>)}
        </div>
      </div>
      {tipEl && tip && <div style={{ position: "absolute", left: Math.min(Math.max(10, tip.x + 16), hostW - 320), top: Math.max(10, tip.y - 150), width: 300, pointerEvents: "none", zIndex: 4 }}>{tipEl}</div>}
    </div>
  );
}
