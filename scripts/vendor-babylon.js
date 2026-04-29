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
    console.log(`Copied ${bundle.packageName}/${sourceRelativePath} -> babylon/${outputFileName}`);
  }
}