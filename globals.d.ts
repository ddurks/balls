// Ambient declarations for the browser globals this project loads from vendored
// <script> tags (not npm modules). Typing them as `any` keeps `checkJs` quiet
// about them while still catching typos/arity errors in the game's own code.
// (window/document/navigator come from the "DOM" lib in jsconfig.json.)

declare const BABYLON: any;
declare function HavokPhysics(): Promise<any>;
