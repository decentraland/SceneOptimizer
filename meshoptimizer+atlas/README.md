# meshoptimizer + atlas

This folder is **reference and design notes** for two SceneOptimizer pipeline
stages whose actual implementation lives in `../src/`:

- **Mesh optimization** — `../src/meshopt.js` (Phase 1, implemented)
- **Cross-GLB material canonicalization** — Phase 2(I), pending
- **Cross-GLB texture atlasing** — Phase 2(II), pending

The pipeline order is:

```
extract → compress → dedup → meshopt → (canonicalize → atlas)
```

Each stage reads its predecessor's output folder and writes to a new sibling
folder so originals are never touched.

---

## Phase 1 — Mesh optimization (gltfpack)

`../src/meshopt.js` shells out to the `gltfpack` npm binary and applies a
fixed flag set whose every entry is there for a Decentraland-runtime reason.
**Do not change these defaults without verifying the corresponding DCL
behaviour.** They were validated against Genesis Plaza by a previous dev.

| Flag   | Why it's mandatory for DCL                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-tr`  | Keep external texture URIs. Without this, `gltfpack` would inline the sibling PNGs that the `extract`/`dedup` stages just wrote out. We want the textures shared on disk; embedding undoes that.                                                    |
| `-kn`  | Keep named nodes and meshes. Decentraland identifies collider geometry by node name (the `_collider` suffix convention). If `gltfpack` strips names, runtime collider lookup silently fails.                                                        |
| `-vpf` | Float positions instead of int + node scale. With the default `-vpi`, `gltfpack` inserts unnamed child nodes under named ones to hold the scale factor, which breaks DCL's collider-by-name lookup. Costs ~7% of the savings but preserves topology. |
| `-kv`  | Keep source vertex attributes even if unused. DCL applies some textures at runtime to "image plane" meshes that have no material in the static glTF. Without `-kv`, `gltfpack` drops their UVs as unused, and runtime texturing breaks.             |
| `-vtf` | Store UVs as float instead of quantized int. glTFast issues #75 and #814 cause non-normalized integer UVs from `KHR_mesh_quantization` to be interpreted incorrectly, manifesting as garbled textures on runtime-textured image planes.            |

Normals, colors, and animations are still quantized by gltfpack defaults —
only positions and UVs are de-quantized by the flags above.

### Optional: `-cc` for `EXT_meshopt_compression`

`-cc` (or `-cz` for higher ratio) enables meshopt-style buffer compression. It
is **not** enabled by default because it requires the runtime to ship the
`EXT_meshopt_compression` decoder. Verify Decentraland's loader supports it
before turning it on, then pass it via the **Extra gltfpack flags** field in
the UI or `--extra-flags "-cc"` on the CLI.

### CLI

```sh
scene-optimizer meshopt <folder> [--outdir <dir>] [--separate-folders] [--extra-flags "..."] [--no-report]
```

`<folder>` is the post-`compress`/`dedup` output. Default output is
`<folder>/meshopt`.

### UI

Web UI shows a **Mesh Optimization** card after at least one GLB has been
extracted. The card has fields for the output subfolder name and any extra
`gltfpack` flags. Per-file progress, top-savings list, and a TSV report
(`meshopt-report.tsv`) are written into the output folder.

---

## Phase 2(I) — Cross-GLB material canonicalization (CLI + API only)

Each GLB defines its own material objects. When 23 GLBs all reference
`CT-Pallete.png`, they each instantiate their own `palettePlastic_mat` on
load, which the runtime sees as 23 distinct materials. Most engines (DCL's
Babylon.js explorer included) do **not** dedupe materials across separately-
loaded glTFs.

The canonicalization stage in [`../src/canonicalize.js`](../src/canonicalize.js)
hashes each material's PBR parameters (baseColor texture URI, normal/ORM/
emissive URIs, factors, alphaMode, sampler state) and ensures that any two
GLBs whose materials hash equal are written with the same material name and
identical normalized parameters. It also collapses within-GLB duplicate
materials and remaps primitive references. This is a prerequisite for
Phase 2(II) and produces cleaner files; on its own it does not reduce draw
calls in most runtimes.

Currently exposed via CLI and HTTP only — no UI card yet:

```sh
scene-optimizer canonicalize <folder>
# or
curl -X POST http://localhost:3000/api/canonicalize \
  -H 'Content-Type: application/json' \
  -d '{"subdir":"canonicalized"}'
```

The web UI card is a follow-up.

## Phase 2(II) — Cross-GLB texture atlasing (planned)

Many small unique baseColors / normals / ORMs across the long-tail of GLBs
can be packed into shared atlas pages. For each group of compatible GLBs:

1. Resize sources to a common tile size (e.g., 512).
2. Composite tiles into shared baseColor / normal / ORM atlas images
   (sRGB-aware for color and emissive, linear for normal/ORM).
3. Remap each GLB's `TEXCOORD_0` accessor so its 0–1 UV space maps into its
   tile region of the atlas.
4. Reassign primitives to the canonical atlas material from Phase 2(I).
5. Skip materials with UVs outside `[0, 1]` (tileable textures): the atlas
   model breaks for them. The Blender reference operator already implements
   this detection — see `reference/export_material_atlas.py` lines 305–360.

---

## `reference/`

- `optimize-glbs.sh` — the original validated bash script. Kept verbatim as
  the source-of-truth for the gltfpack flag set. **Not run by the pipeline.**
- `export_material_atlas.py` — the Blender operator that inspired Phase 2(II).
  We are not using Blender at runtime; this is here as a design reference for
  the pure-Node port (especially the tileable-UV detection at lines 305–360
  and the LAYOUT_2 / LAYOUT_4 atlas tile geometry at the top of the file).
