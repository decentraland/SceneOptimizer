# SceneOptimizer

Extract and compress textures from GLB files for Decentraland scenes. Built for artists — no terminal required.

## What it does

1. **Extract** — Reads GLB files, pulls out all textures, and writes stripped-down GLBs that reference external textures via URIs. Shared textures across GLBs are automatically deduplicated. By default, models and textures are placed in the same output folder (recommended for engine compatibility). Optionally, they can be separated into `models/` and `textures/` subfolders.

2. **Compress** — Resizes and compresses textures with per-type control (baseColor, normal, ORM, emissive). Supports PNG, JPEG, and WebP output with optional denoising.

## For artists (ZIP distribution)

Download the ZIP for your platform from the releases:

| Platform | File |
|----------|------|
| macOS Apple Silicon | `SceneOptimizer-macos-arm64.zip` |
| macOS Intel | `SceneOptimizer-macos-x64.zip` |
| Windows | `SceneOptimizer-win-x64.zip` |

1. Unzip the file
2. Double-click `start.command` (Mac) or `start.bat` (Windows)
3. The app opens in your browser at `http://localhost:3000`
4. Drag and drop your **watch folder** (containing GLB files) and **output folder**
5. Click **Extract** to pull textures out of GLBs
6. Adjust compression settings (max sizes, quality, format, denoise) and click **Compress**

## For developers

### Prerequisites

- Node.js 22+

### Setup

```bash
npm install
```

### Run the web UI

```bash
npm run ui
```

Opens at `http://localhost:3000`.

### CLI usage

```bash
# Extract textures from GLBs (all assets in one folder — default)
node src/index.js extract "path/to/models/*.glb" -o ./output

# Extract with separate models/ and textures/ subfolders
node src/index.js extract "path/to/models/*.glb" -o ./output --separate-folders

# Compress textures (in-place)
node src/index.js compress ./output
```

#### Extract options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --outdir <dir>` | `./output` | Output directory |
| `-s, --separate-folders` | `false` | Put models and textures in separate subfolders |

#### Compress options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --outdir <dir>` | in-place | Output directory |
| `-b, --basecolor-size <n>` | `1024` | Max height for baseColor textures |
| `-n, --normal-size <n>` | `1024` | Max height for normal maps |
| `-r, --orm-size <n>` | `512` | Max height for ORM textures |
| `-e, --emissive-size <n>` | `512` | Max height for emissive textures |
| `--other-size <n>` | `512` | Max height for other textures |
| `-q, --quality <n>` | `85` | Compression quality (1-100) |
| `-d, --depth <n>` | `8` | Bit depth: 8 or 16 |
| `-f, --format <fmt>` | `png` | Output format: png, jpeg, webp |
| `--denoise <level>` | `off` | Denoise: off, light, medium, strong |

### Build distribution ZIPs

```bash
npm run build
```

Produces self-contained ZIPs in `dist/` for macOS (arm64 + x64) and Windows (x64), each with an embedded Node.js runtime.

Build a single target:

```bash
npm run build -- --target macos-arm64
```

## How it works

- Uses [gltf-transform](https://gltf-transform.dev/) to parse GLB files and extract texture data
- By default, GLBs and textures go into the same output folder so engines can resolve texture URIs directly by filename. An optional "separate folders" mode writes to `models/` and `textures/` subfolders with `../textures/` URI references
- Textures retain their original names from inside the GLB
- When a texture is used in multiple material slots (e.g. baseColor + emissive), the highest-priority category determines the compression size
- Deduplication works by matching original texture name + dimensions, with a pixel-hash fallback for unnamed or renamed textures
- Misaligned GLBs (violating the 4-byte alignment spec) are automatically fixed before processing
- GLBs that already have external texture references are detected and copied as-is

## Project structure

```
src/
  index.js        CLI entry point
  server.js       Express web server + SSE
  extract.js      GLB texture extraction + dedup
  compress.js     Texture compression pipeline
  utils.js        Shared helpers
  public/
    index.html    Web UI (single-page app)
scripts/
  build-dist.js   ZIP distribution builder
```
