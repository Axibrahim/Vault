import * as THREE from "../../vendor/three.module.min.js";

// Targets for each screen. The scene eases toward them, so changes feel physical.
const STATES = {
  login:   { spin: 0.12, bolts: 0,   open: 0, core: 0.35, color: 0xf0b45b, zoom: 9.0 },
  enroll:  { spin: 0.45, bolts: 0,   open: 0, core: 0.8,  color: 0xf0b45b, zoom: 8.2 },
  desktop: { spin: 0.18, bolts: 0.7, open: 1, core: 1.0,  color: 0x5be3a0, zoom: 7.6 },
  other:   { spin: 0.05, bolts: 0,   open: 0, core: 0.25, color: 0xe5584b, zoom: 9.0 },
  pair:    { spin: 0.45, bolts: 0.3, open: 0, core: 0.8,  color: 0xf0b45b, zoom: 8.2 },
  phone:   { spin: 0.18, bolts: 0.7, open: 1, core: 1.0,  color: 0x5be3a0, zoom: 7.6 },
};

let target = STATES.login;
export function setSceneState(name) {
  target = STATES[name] || STATES.login;
  document.body.dataset.view = name;
  if (still && renderer) frame(0);
}

const canvas = document.getElementById("scene");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let renderer, scene, camera, rig, rings, bolts, core, coreMat, dust, light;
const cur = { spin: 0.12, bolts: 0, open: 0, core: 0.35, zoom: 9 };
const color = new THREE.Color(0xf0b45b);
const mouse = { x: 0, y: 0 };
const ease = (a, b, k) => a + (b - a) * k;
let last = performance.now();

try {
  const phone = Math.min(innerWidth, innerHeight) < 600;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !phone, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.z = 9;

  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.85, roughness: 0.35 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb9863a, metalness: 0.9, roughness: 0.3 });
  rig = new THREE.Group();
  scene.add(rig);

  const outer = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.14, 24, 120), steel);
  const mid = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.07, 20, 100), brass);
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 0.12, 64), steel);
  dial.rotation.x = Math.PI / 2;
  const ticks = new THREE.Group();
  for (let i = 0; i < 36; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(i % 3 ? 0.03 : 0.05, i % 3 ? 0.14 : 0.26, 0.05), brass);
    const a = (i / 36) * Math.PI * 2;
    t.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0.1);
    t.rotation.z = a - Math.PI / 2;
    ticks.add(t);
  }
  rings = { outer, mid, dial, ticks };
  rig.add(outer, mid, dial, ticks);

  bolts = [];
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.2), steel);
    b.userData.a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    bolts.push(b);
    rig.add(b);
  }

  coreMat = new THREE.MeshBasicMaterial({ color: 0xf0b45b, wireframe: true, transparent: true });
  core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1), coreMat);
  rig.add(core);

  const pts = new Float32Array((phone ? 350 : 900) * 3);
  for (let i = 0; i < pts.length; i += 3) {
    const r = 5 + Math.random() * 7, a = Math.random() * 6.283, e = Math.acos(2 * Math.random() - 1);
    pts[i] = r * Math.sin(e) * Math.cos(a); pts[i + 1] = r * Math.sin(e) * Math.sin(a); pts[i + 2] = r * Math.cos(e) - 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  dust = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.03, color: 0x8a8f98, transparent: true, opacity: 0.55 }));
  scene.add(dust);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  light = new THREE.PointLight(0xf0b45b, 90, 30);
  light.position.set(3, 3, 6);
  scene.add(light);
  const rim = new THREE.PointLight(0x6a8cff, 40, 30);
  rim.position.set(-5, -2, 3);
  scene.add(rim);

  addEventListener("resize", fit);
  addEventListener("orientationchange", () => setTimeout(fit, 250));
  // Phones can drop the WebGL context when the tab is backgrounded; recover quietly.
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextrestored", () => { last = performance.now(); still ? frame(0) : loop(); });
  addEventListener("pointermove", (e) => {
    mouse.x = (e.clientX / innerWidth - 0.5) * 2;
    mouse.y = (e.clientY / innerHeight - 0.5) * 2;
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !still) loop(); });
  fit();
  still ? frame(0) : loop();
} catch (err) {
  document.documentElement.classList.add("no-webgl"); // the CSS gradient background still looks fine
  console.warn("Vault 3D scene disabled:", err);
}

function fit() {
  const w = innerWidth, h = innerHeight, aspect = w / h, wide = aspect > 1.1 && w > 860;
  renderer.setSize(w, h, false);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const viewH = 2 * 9 * Math.tan((camera.fov * Math.PI) / 360);   // world height visible at z = 9
  if (wide) {
    rig.position.set(3, 0, 0);
    rig.scale.setScalar(1);
  } else {
    // Phones: the door sits in the top third and always fits the screen width.
    rig.scale.setScalar(Math.max(0.3, Math.min(0.62, (viewH * aspect * 0.9) / 6.6)));
    rig.position.set(0, viewH * (h < 520 ? 0.05 : 0.3), 0);
  }
  if (still) frame(0);
}


function frame(dt) {
  const k = Math.min(1, dt * 2.2 || 1);
  for (const key of ["spin", "bolts", "open", "core", "zoom"]) cur[key] = ease(cur[key], target[key], k);
  color.lerp(new THREE.Color(target.color), k);
  const t = performance.now() / 1000;

  rings.mid.rotation.z += dt * cur.spin;
  rings.ticks.rotation.z -= dt * cur.spin * 1.6;
  rings.outer.rotation.z = cur.open * 0.6;
  rings.dial.rotation.y = cur.open * 0.5;
  core.rotation.y += dt * (0.3 + cur.spin);
  core.rotation.x += dt * 0.2;
  coreMat.color.copy(color);
  coreMat.opacity = 0.25 + cur.core * (0.5 + 0.2 * Math.sin(t * 2));
  light.color.copy(color);
  for (const b of bolts) {
    const r = 2.45 + cur.bolts * 0.55;
    b.position.set(Math.cos(b.userData.a) * r, Math.sin(b.userData.a) * r, 0);
    b.rotation.z = b.userData.a;
  }
  dust.rotation.y += dt * 0.01;
  rig.rotation.y = ease(rig.rotation.y, mouse.x * 0.35 + Math.sin(t * 0.5) * 0.12, 0.05);
  rig.rotation.x = ease(rig.rotation.x, mouse.y * 0.2, 0.05);
  camera.position.z = cur.zoom;
  renderer.render(scene, camera);
}

function loop() {
  if (still || document.hidden || !renderer) return;
  const now = performance.now();
  frame(Math.min((now - last) / 1000, 0.05));
  last = now;
  requestAnimationFrame(loop);
}