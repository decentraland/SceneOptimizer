# SceneOptimizer

Extract, deduplicate, and compress textures from GLB files for Decentraland scenes.

## What it does

1. **Extract** — Reads GLB files, pulls out all textures, and writes stripped-down GLBs that reference external textures via URIs. Shared textures across GLBs are automatically deduplicated. By default, models and textures are placed in the same output folder (recommended for engine compatibility). Optionally, they can be separated into `models/` and `textures/` subfolders.

2. **Deduplicate** — Scans extracted textures for duplicates using two methods: Blender-style suffix detection (`_9`, `.002`) and pixel-hash content matching (finds identical textures with completely different names). Includes a visual comparison tool (2-up, Swipe, Onion Skin, Difference) so artists can verify before deleting. Rewrites GLB texture references and removes duplicate files.

3. **Compress** — Resizes textures with per-type control (baseColor, normal, ORM, emissive). PNG compression uses [oxipng](https://github.com/shssoichern/oxipng) (lossless, WASM) for optimal file sizes without quality loss. JPEG and WebP use Sharp with a configurable quality slider. Optional denoising via median filter + sharpen.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or later
- [Git](https://git-scm.com/)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/decentraland/SceneOptimizer.git
cd SceneOptimizer
npm install
```

### Run the web UI

```bash
npm run ui
```

Opens at `http://localhost:3000`. From the web UI you can:

1. Drag and drop your **watch folder** (containing GLB files) and **output folder**
2. Click **Extract** to pull textures out of GLBs
3. Click **Scan for Duplicates** to find redundant textures, compare them visually, and delete selected duplicates
4. Adjust compression settings (max sizes per texture type, format, denoise) and click **Compress**

### CLI usage

```bash
# Extract textures from GLBs (all assets in one folder — default)
node src/index.js extract "path/to/models/*.glb" -o ./output

# Extract with separate models/ and textures/ subfolders
node src/index.js extract "path/to/models/*.glb" -o ./output --separate-folders

# Scan for duplicate textures (dry run)
node src/index.js dedup ./output

# Scan and apply — rewrite GLBs + delete duplicates
node src/index.js dedup ./output --apply

# Compress textures (in-place)
node src/index.js compress ./output
```

#### Extract options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --outdir <dir>` | `./output` | Output directory |
| `-s, --separate-folders` | `false` | Put models and textures in separate subfolders |

#### Dedup options

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --separate-folders` | `false` | Models and textures are in separate subfolders |
| `--apply` | `false` | Apply changes (rewrite GLBs + delete duplicates) |

#### Compress options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --outdir <dir>` | in-place | Output directory |
| `-b, --basecolor-size <n>` | `1024` | Max height for baseColor textures |
| `-n, --normal-size <n>` | `1024` | Max height for normal maps |
| `-r, --orm-size <n>` | `512` | Max height for ORM textures |
| `-e, --emissive-size <n>` | `512` | Max height for emissive textures |
| `--other-size <n>` | `512` | Max height for other textures |
| `-q, --quality <n>` | `85` | Compression quality 1-100 (JPEG/WebP only — PNG uses lossless oxipng) |
| `-d, --depth <n>` | `8` | Bit depth: 8 or 16 |
| `-f, --format <fmt>` | `png` | Output format: png, jpeg, webp |
| `--denoise <level>` | `off` | Denoise: off, light, medium, strong |

### Build distribution ZIPs (optional)

The build script can produce self-contained ZIPs in `dist/` for macOS (arm64 + x64) and Windows (x64), each with an embedded Node.js runtime:

```bash
npm run build
```

Build a single target:

```bash
npm run build -- --target macos-arm64
```

> **Note:** Pre-built ZIPs are not currently published as releases. To distribute the tool, you must build them yourself using the commands above.

## How it works

- Uses [gltf-transform](https://gltf-transform.dev/) to parse GLB files and extract texture data
- By default, GLBs and textures go into the same output folder so engines can resolve texture URIs directly by filename. An optional "separate folders" mode writes to `models/` and `textures/` subfolders with `../textures/` URI references
- Textures retain their original names from inside the GLB
- When a texture is used in multiple material slots (e.g. baseColor + emissive), the highest-priority category determines the compression size
- Extraction deduplication works by matching original texture name + dimensions, with a pixel-hash fallback for unnamed or renamed textures
- Post-extraction deduplication scans for Blender-style suffix duplicates (`_9`, `.002`) and content-identical textures (different names, same pixels via SHA-256 hash)
- PNG compression uses [oxipng](https://github.com/nicksay/oxipng) via WASM — lossless optimization that tries multiple filter strategies. Sharp is only used when resize or denoise is needed, never for final PNG encoding
- Compression runs in parallel across all CPU cores for speed
- Misaligned GLBs (violating the 4-byte alignment spec) are automatically fixed before processing
- GLBs that already have external texture references are detected and copied as-is

## Project structure

```
src/
  index.js        CLI entry point (extract, compress, dedup)
  server.js       Express web server + SSE + dedup API
  extract.js      GLB texture extraction + dedup during extraction
  compress.js     Texture compression (oxipng for PNG, Sharp for JPEG/WebP)
  dedup.js        Post-extraction duplicate detection + GLB rewriting
  utils.js        Shared helpers (classification, formatting, MIME types)
  public/
    index.html    Web UI (single-page app with visual comparison tool)
scripts/
  build-dist.js   ZIP distribution builder
```
