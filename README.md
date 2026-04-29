# Golf Ball - Driving Range Demo

A physics-based golf game built with **Babylon.js** and **Havok Physics Engine** where you play as the ball!

## Features

- **Ball Physics**: Realistic golf ball physics with Havok physics engine
- **Swipe Controls**: Hit the ball with a swipe gesture (mouse or touch)
- **Spin Mechanics**: Drag further to apply spin to the ball - creates visual rotation on the "spin" bone
- **Dynamic Camera**: Third-person follow camera that keeps the ball centered in the bottom third of the screen
- **Driving Range**: Practice hitting from an open driving range with visual feedback
- **Cartoon Physics**: Exaggerated spin effects for fun, arcade-like gameplay

## Controls

- **Click/Swipe to Hit**: Short drag = soft hit, long drag = hard hit
- **Drag to Add Spin**: The further you drag, the more spin is applied
- **Space Bar**: Reset ball to starting position
- **Visual Feedback**: Real-time speed, spin, height, and distance display

## How to Run

### Option 1: Using Node.js (Recommended)

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

`npm install` now automatically vendors the Babylon and Havok browser files into `babylon/` via the `postinstall` script.

## Updating Babylon and Havok

This project vendors browser-ready runtime files into `babylon/` instead of loading them from a CDN.

When you intentionally change Babylon or Havok versions, update the versions in `package.json` together and then run:

```bash
npm install
```

`npm install` runs `npm run vendor:babylon` automatically.

If you need to refresh the vendored files without reinstalling dependencies, run:

```bash
npm run vendor:babylon
```

That copies these runtime files from `node_modules` into `babylon/`:

- `babylon.js`
- `babylonjs.loaders.min.js`
- `babylonjs.materials.min.js`
- `HavokPhysics_umd.js`
- `HavokPhysics.wasm`

Keep those versions aligned so the vendored browser files and installed packages do not drift.

### Option 2: Using Python 3

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

### Option 3: Direct File

Simply open `index.html` directly in a modern browser (may have CORS issues with the model).

## File Structure

- `index.html` - Main HTML file with UI elements
- `game.js` - Game logic, physics, input handling, and camera system
- `assets/gball.glb` - Golf ball character 3D model
- `package.json` - Node.js dependencies
- `server.js` - Simple Express server for local development

## Game Mechanics

### Hitting

1. Click and drag on the canvas
2. The direction and distance determine the hit force and direction
3. Release to hit the ball

### Spinning

1. Click and drag a longer distance (>10 pixels)
2. A spin bar appears at the bottom showing spin intensity
3. Release to apply spin to the ball
4. When the ball lands, the spin affects its trajectory and distance in a cartoon style

### Camera System

- The camera follows the ball with a fixed offset
- The ball remains in the bottom third of the screen, centered
- The camera looks slightly ahead of the ball's movement direction

## Technical Details

- **Engine**: Babylon.js
- **Physics**: Havok Physics Engine v2
- **Golf Ball Mass**: 45 grams (realistic)
- **Physics Material**: Low friction (0.3), moderate restitution (0.6)
- **Render Loop**: Continuous update with physics simulation

## Future Enhancements

- Multiple holes/courses
- Power meter for more precise hits
- Different club types
- Wind effects
- Terrain variations (slopes, water hazards)
- Score tracking
- Multiplayer support
