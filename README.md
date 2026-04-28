# SceneOptimizer

Extract, deduplicate, and compress textures from GLB files for Decentraland scenes. Built for artists — no terminal required.

## What it does

1. **Extract** — Reads GLB files, pulls out all textures, and writes stripped-down GLBs that reference external textures via URIs. Shared textures across GLBs are automatically deduplicated during extraction. By default, models and textures are placed in the same output folder (recommended for engine compatibility). Optionally, they can be separated into `models/` and `textures/` subfolders.

2. **Deduplicate** — Scans extracted textures for duplicates using two methods: Blender-style suffix detection (`_9`, `.002`) and pixel-hash content matching (finds identical textures with completely different names). Includes a visual comparison tool (2-up, Swipe, Onion Skin, Difference) so artists can verify before deleting. Rewrites GLB texture references and removes duplicate files.

3. **Compress** — Resizes textures with per-type control (baseColor, normal, ORM, emissive). PNG compression uses [oxipng](https://github.com/shssoichern/oxipng) (lossless, WASM) for optimal file sizes without quality loss. JPEG and WebP use Sharp with a configurable quality slider. Optional denoising via median filter + sharpen. Textures are processed in parallel across all CPU cores.

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
4. Select a **watch folder** (with GLB files) and **output folder**:
   - **Click** the drop zone — opens the native folder picker (Chrome/Edge)
   - **Or drag & drop** a folder from Finder / File Explorer
   - **Or paste a path** manually
5. Click **Extract** to pull textures out of GLBs
6. Click **Scan for Duplicates** to find redundant textures, compare them visually, and delete selected duplicates
7. Adjust compression settings (max sizes per texture type, format, denoise) and click **Compress**

### How folder selection works

Browsers don't expose the absolute path of a picked/dropped folder for privacy reasons. To resolve it, SceneOptimizer reads 3 file sizes inside the folder and uses the OS's file indexer to find an exact match:

- **macOS** — uses Spotlight (`mdfind`) for instant results
- **Windows** — uses PowerShell `Get-ChildItem` to search under Documents, Desktop, Downloads, Projects, and the home folder

If the fingerprint matches a single folder, it's used automatically. If multiple folders contain identical files (e.g. duplicated project trees), a picker appears. If nothing matches, a text input appears for manual entry.

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

### Extraction
- Uses [gltf-transform](https://gltf-transform.dev/) to parse GLB files and extract texture data
- By default, GLBs and textures go into the same output folder so engines can resolve texture URIs directly by filename. An optional "separate folders" mode writes to `models/` and `textures/` subfolders with `../textures/` URI references
- Textures retain their original names from inside the GLB
- When a texture is used in multiple material slots (e.g. baseColor + emissive), the highest-priority category determines the compression size
- Extraction deduplication works by matching original texture name + dimensions, with a pixel-hash fallback for unnamed or renamed textures
- Misaligned GLBs (violating the 4-byte alignment spec) are automatically fixed before processing
- GLBs that already have external texture references are detected and copied as-is

### Deduplication
- **Suffix detection** — catches Blender-style numbered exports (`wood_9.png`, `wood.002.png`) by pattern-matching the filename and comparing to the canonical base name
- **Content matching** — hashes every texture's raw pixel data (SHA-256) and groups files with identical content, regardless of filename. Catches cases like `Manhole_baseColor.png` == `Regenesis_manhole_v01_basecolor.png`
- **Visual comparison** — each group can be expanded into a comparison viewer with 4 modes: 2-up (side-by-side), Swipe (draggable divider), Onion Skin (opacity slider), and Difference (pixel diff with amplification)
- **GLB rewriting** — when applied, the `images[].uri` field inside each GLB's JSON chunk is rewritten to point to the canonical texture, preserving 4-byte alignment. Orphaned duplicate files (not referenced by any GLB) are simply deleted

### Compression
- PNG compression uses [oxipng](https://github.com/shssoichern/oxipng) via WASM — lossless optimization that tries multiple filter strategies at level 2
- Sharp is only invoked when resize or denoise is needed; final PNG encoding is always oxipng
- JPEG and WebP use Sharp with the quality slider (since those formats are inherently lossy)
- All textures are processed in parallel across all CPU cores

### Folder resolution
- Browsers hide the absolute path of picked/dropped folders for privacy. To resolve, the client reads 3 file sizes from the folder and the server uses OS-native search to find a match
- macOS: Spotlight (`mdfind`) with `kMDItemFSName == X && kMDItemFSSize == Y` — extremely specific and fast
- Windows: PowerShell `Get-ChildItem` across common user folders — slower but reliable
- If multiple real matches exist (truly duplicate project folders), a picker is shown; otherwise auto-resolves

## Project structure

```
src/
  index.js        CLI entry point (extract, compress, dedup)
  server.js       Express web server + SSE + fingerprint folder resolver
  extract.js      GLB texture extraction + dedup during extraction
  compress.js     Texture compression (oxipng for PNG, Sharp for JPEG/WebP)
  dedup.js        Post-extraction duplicate detection + GLB rewriting
  utils.js        Shared helpers (classification, formatting, MIME types)
  public/
    index.html    Web UI (single-page app with visual comparison tool)
scripts/
  build-dist.js   ZIP distribution builder
```
