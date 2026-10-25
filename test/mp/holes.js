// The golf server's hole table (drawvidverse worldserver/src/games/golf/engine.ts
// HOLES and CLUB_MAX_DISTANCE), mirrored for bots and checks. Client world
// coordinates, after loadHole() centres each hole on the origin.
const SERVER_HOLES = [
  {
    id: 1,
    par: 4,
    version: "greens6",
    tee: { x: 0, y: 1.57, z: 126.43 },
    pins: [
      { x: 0, y: 0.78, z: -121.57 },
      { x: 10, y: 0.8, z: -123.57 },
      { x: -11, y: 0.83, z: -126.57 },
      { x: -9, y: 0.25, z: -103.57 },
      { x: 9, y: 0.11, z: -104.57 },
    ],
    bounds: {
      minX: -59,
      maxX: 59,
      minY: -10,
      maxY: 3,
      minZ: -147.3,
      maxZ: 147.3,
    },
  },
  {
    id: 2,
    par: 3,
    version: "greens6",
    tee: { x: 0, y: 13.35, z: 80 },
    pins: [
      { x: 8, y: 0.01, z: -68 },
      { x: -8, y: 0.12, z: -70 },
      { x: 0, y: -0.13, z: -53 },
      { x: 0, y: 0.35, z: -75 },
      { x: 9, y: -0.1, z: -59 },
    ],
    bounds: {
      minX: -46.9,
      maxX: 46.9,
      minY: -10,
      maxY: 13.4,
      minZ: -100.9,
      maxZ: 100.9,
    },
  },
  {
    id: 3,
    par: 5,
    version: "greens6",
    tee: { x: -9.97, y: 1.56, z: 212.39 },
    pins: [
      { x: 35.03, y: 0.63, z: -199.61 },
      { x: 43.03, y: 0.46, z: -208.61 },
      { x: 28.03, y: 0.73, z: -211.61 },
      { x: 40.03, y: 0.58, z: -192.61 },
      { x: 24.03, y: 0.6, z: -193.61 },
    ],
    bounds: {
      minX: -71,
      maxX: 71,
      minY: -10,
      maxY: 3.3,
      minZ: -232.3,
      maxZ: 232.3,
    },
  },
];

const CLUB_MAX = [22, 55, 66, 88, 109, 131, 153, 175, 197, 241, 263, 252, 306];
const STROKE_CAP = 10;

const holeById = (id) => SERVER_HOLES.find((h) => h.id === id);

module.exports = { SERVER_HOLES, CLUB_MAX, STROKE_CAP, holeById };
