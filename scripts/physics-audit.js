// Controlled Havok audit: node scripts/physics-audit.js
// Flat-green putts use the gameplay rolling law and landing state. Airborne clubs
// measure isolated, spin-free carry with the ground removed after settling,
// so a bounce cannot be mistaken for first return to launch height. No wind.
// This excludes course geometry, cup capture, and render/input behavior.
const root = require("node:path").resolve(__dirname, "..");
const B = (globalThis.BABYLON = require(root + "/node_modules/babylonjs"));
const fs = require("fs");
const HK = require(
  root + "/node_modules/@babylonjs/havok/lib/umd/HavokPhysics_umd.js",
);
globalThis.window = { innerWidth: 1280, removeEventListener() {} };
globalThis.Shared = require(root + "/src/shared/shared.js");
const { CONFIG } = require(root + "/src/game/config.js");
require(root + "/src/game/utils.js");
const { PhysicsManager } = require(root + "/src/game/physics.js");
const { GolfBallGuy } = require(root + "/src/game/character.js");
const { ClubData } = require(root + "/src/game/clubs.js");
const { SURFACE_PHYSICS } = require(root + "/src/game/course.js");
async function createPhysicsLab() {
  const hk = await HK({
    wasmBinary: fs.readFileSync(
      root + "/node_modules/@babylonjs/havok/lib/umd/HavokPhysics.wasm",
    ),
  });
  const engine = new B.NullEngine();
  function shot(club, power, fps) {
    const scene = new B.Scene(engine);
    PhysicsManager.enable(scene, new B.HavokPlugin(true, hk));
    const ground = B.MeshBuilder.CreateGround(
      "surf_green",
      { width: 2000, height: 2000 },
      scene,
    );
    const green = SURFACE_PHYSICS.green;
    const groundAg = new B.PhysicsAggregate(
      ground,
      B.PhysicsShapeType.MESH,
      { mass: 0, friction: green.friction, restitution: green.restitution },
      scene,
    );
    ground._surfacePhysics = green;
    const mesh = B.MeshBuilder.CreateSphere(
      "ball",
      { diameter: CONFIG.BALL.COLLIDER_DIAMETER, segments: 8 },
      scene,
    );
    mesh.position.y = CONFIG.BALL.COLLIDER_DIAMETER / 2;
    const ag = new B.PhysicsAggregate(
      mesh,
      B.PhysicsShapeType.SPHERE,
      {
        mass: CONFIG.BALL.MASS,
        friction: CONFIG.BALL.FRICTION,
        restitution: CONFIG.BALL.RESTITUTION,
      },
      scene,
    );
    ag.body.setLinearDamping(CONFIG.BALL.LINEAR_DAMPING);
    ag.body.setAngularDamping(CONFIG.BALL.ANGULAR_DAMPING);
    const ball = new GolfBallGuy(mesh, ag.body, null, scene);
    ball.updateSpinAura = () => {};
    const dt = 1 / fps;
    function tick() {
      scene._advancePhysicsEngineStep(dt * 1000);
      if (club.angle === 0) {
        ball.updateLandingState();
      }
    }
    for (let i = 0; i < fps; i++) tick();
    if (club.angle !== 0) groundAg.dispose();
    const start = mesh.position.clone();
    ball.landed = false;
    ball.touchedGround = false;
    ball.applyHit(0, 0, 175 * power, 0, club.angle, club.v0);
    let carry = null,
      apex = 0,
      prev = mesh.position.clone(),
      frames = 0;
    for (; frames < fps * 60; frames++) {
      tick();
      const p = mesh.position;
      apex = Math.max(apex, p.y - start.y);
      if (carry === null && apex > 0.3 && p.y <= start.y) {
        const t = (prev.y - start.y) / (prev.y - p.y);
        carry = Math.hypot(
          prev.x + (p.x - prev.x) * t - start.x,
          prev.z + (p.z - prev.z) * t - start.z,
        );
      }
      prev.copyFrom(p);
      if (ball.landed || carry !== null) break;
    }
    const out = {
      club: club.name,
      power,
      fps,
      carry: carry === null ? null : +carry.toFixed(2),
      total:
        club.angle === 0
          ? +Math.hypot(
              mesh.position.x - start.x,
              mesh.position.z - start.z,
            ).toFixed(2)
          : null,
      target: club.maxDistance,
      complete: ball.landed || carry !== null,
    };
    scene.dispose();
    if (!out.complete) throw new Error(`Shot did not complete: ${club.name}`);
    return out;
  }
  return { shot, dispose: () => engine.dispose() };
}

module.exports = { createPhysicsLab };

if (require.main === module) {
  (async () => {
    const lab = await createPhysicsLab();
    try {
      for (const fps of [30, 60, 120])
        for (const power of [0.1, 0.25, 0.5, 1])
          console.log(JSON.stringify(lab.shot(ClubData.CLUBS[0], power, fps)));
      for (const club of ClubData.CLUBS.slice(1))
        console.log(JSON.stringify(lab.shot(club, 1, 60)));
    } finally {
      lab.dispose();
    }
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
