const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "babylon");

function resolvePackageRoot(packageName) {
  let resolvedPath;

  try {
    resolvedPath = require.resolve(path.join(packageName, "package.json"));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw error;
    }

    resolvedPath = require.resolve(packageName);
  }

  let currentDir = path.dirname(resolvedPath);

  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

      if (packageJson.name === packageName) {
        return currentDir;
      }
    }

    currentDir = path.dirname(currentDir);
  }

  throw new Error(`Could not resolve package root for ${packageName}`);
}

// NOTE: babylon/ktx2/ (the KTX2 transcoder: babylon.ktx2Decoder.js + the
// ktx2Transcoders/1/*.wasm set + zstddec.wasm) is NOT shipped in the npm
// packages — Babylon fetches it from cdn.babylonjs.com at runtime by default. We
// self-host it (see Shared.URLConfig in src/shared/shared.js) so course normal
// maps transcode with no CDN round-trip. Those files are committed to the repo,
// not vendored here. To refresh them:
//   curl -s https://cdn.babylonjs.com/babylon.ktx2Decoder.js -o babylon/ktx2/babylon.ktx2Decoder.js
//   curl -s https://cdn.babylonjs.com/zstddec.wasm -o babylon/ktx2/zstddec.wasm
//   for w in msc_basis_transcoder uastc_astc uastc_bc7 uastc_r8_unorm uastc_rg8_unorm uastc_rgba8_srgb_v2 uastc_rgba8_unorm_v2; do \
//     curl -s "https://cdn.babylonjs.com/ktx2Transcoders/1/$w.wasm" -o "babylon/ktx2/ktx2Transcoders/1/$w.wasm"; done
const bundles = [
  {
    packageName: "babylonjs",
    files: [["babylon.js", "babylon.js"]],
  },
  {
    packageName: "babylonjs-loaders",
    files: [["babylonjs.loaders.min.js", "babylonjs.loaders.min.js"]],
  },
  {
    packageName: "babylonjs-materials",
    files: [["babylonjs.materials.min.js", "babylonjs.materials.min.js"]],
  },
  {
    packageName: "@babylonjs/havok",
    files: [
      ["lib/umd/HavokPhysics_umd.js", "HavokPhysics_umd.js"],
      ["lib/umd/HavokPhysics.wasm", "HavokPhysics.wasm"],
    ],
  },
];

fs.mkdirSync(outputDir, { recursive: true });

for (const bundle of bundles) {
  const packageRoot = resolvePackageRoot(bundle.packageName);

  for (const [sourceRelativePath, outputFileName] of bundle.files) {
    const sourcePath = path.join(packageRoot, sourceRelativePath);
    const outputPath = path.join(outputDir, outputFileName);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing source asset: ${sourcePath}`);
    }

    fs.copyFileSync(sourcePath, outputPath);
    console.log(
      `Copied ${bundle.packageName}/${sourceRelativePath} -> babylon/${outputFileName}`,
    );
  }
}
