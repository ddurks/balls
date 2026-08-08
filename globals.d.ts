// Ambient declarations for the browser globals this project loads from vendored
// <script> tags (not npm modules). Typing them as `any` keeps `checkJs` quiet
// about them while still catching typos/arity errors in the game's own code.
// (window/document/navigator come from the "DOM" lib in jsconfig.json.)

declare const BABYLON: any;
declare function HavokPhysics(): Promise<any>;

// The game/clubhouse expose their instance on window for in-browser debugging.
interface Window {
  game?: any;
}

// The game is split into per-system files loaded as classic <script>s that share
// each other's classes/consts through the global scope (each file does
// Object.assign(globalThis, {...}) at its tail). TypeScript sees each file as a
// separate CommonJS module (they carry a module.exports guard), so without these
// ambient declarations every cross-file reference reads as "Cannot find name".
// Declared `any` — this restores checkJs on each file's own logic (property
// access, arity, control flow) without pretending to type the seams. Mirrors the
// browser/game globals in eslint.config.js; keep the two lists in step.

// Shared helper modules (src/shared/*)
declare const Shared: any;
declare const Balls: any;
declare const Materials: any;
declare const Textures: any;
declare const Lighting: any;
declare const BallsStyle: any;

// Game modules (src/game/*)
declare const GameState: any;
declare const CameraViewMode: any;
declare const PALETTE: any;
declare const UNITS: any;
declare const CONFIG: any;
declare const EventManager: any;
declare const Utils: any;
declare const Wind: any;
declare const CloudSystem: any;
declare const Boid3D: any;
declare const BirdFlockSystem: any;
declare const ClubData: any;
declare const ClubSelector: any;
declare const ClubSystem: any;
declare const TrajectoryArrow: any;
declare const AimView: any;
declare const SwipeArrowOverlay: any;
declare const PhysicsConfig: any;
declare const PhysicsManager: any;
declare const GolfBallGuy: any;
declare const BallTrail: any;
declare const FollowCamera: any;
declare const DroneCamera: any;
declare const GrassSystem: any;
declare const CourseDecor: any;
declare const CourseSurfaces: any;
declare const InputHandler: any;
declare const CircleUIManager: any;
declare const UIManager: any;
declare const PinManager: any;
declare const CourseHUD: any;
declare const CourseUI: any;
declare const BallsMenu: any;
declare const Scoreboard: any;
declare const SwingCoordinator: any;
declare const GameStateCoordinator: any;
declare const SceneSetup: any;
declare const HOLE_ASSET_VERSION: any;
declare const COURSE_HOLES: any;
declare const SURFACE_PHYSICS: any;
declare const CourseManager: any;
declare const SlopeArrows: any;
declare const GolfGame: any;
declare const startGame: any;
declare var golfNet: any; // dev handle exposed by golfnet.js (M0 console driving)
declare const GolfNet: any;
