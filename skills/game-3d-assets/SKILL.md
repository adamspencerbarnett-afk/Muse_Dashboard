---
name: game-3d-assets
description: Make game-ready 3D models (units, props, pieces, terrain parts) for browser games (three.js / glTF / GLB) with Blender, and put them into a three.js game (team colours, squads, marching / fighting animation). Read this BEFORE bundled:blender or plugin:threejs whenever a game task makes or uses a 3D object, model, unit, prop or .glb file.
---

# Game 3D assets with Blender

A game asset is judged in the game, at the size and angle players see it, not in a Blender beauty render.

## Setup facts
- Find Blender first; it is often **not on PATH**. Try `blender --version`; on Windows look for
  `C:\Program Files\Blender Foundation\Blender <version>\blender.exe`
  (`Get-ChildItem 'C:\Program Files\Blender Foundation' -Recurse -Filter blender.exe`), on macOS
  `/Applications/Blender.app/Contents/MacOS/Blender`. If it is not installed, say so and ask before installing it.
- Run builds headless: `<blender> -b --factory-startup --python-exit-code 1 -P tools/build_<name>.py`
  (`--python-exit-code 1` makes a Python error fail the command; without it errors look like success).
- On Windows the shell is PowerShell 5.1: write scripts to files; no heredocs.
- Headless Edge or Chrome with `puppeteer-core`, and `three`, are usually in the game project's `node_modules`.
- The Blender Python API reference for the installed version is at `https://docs.blender.org/api/<major.minor>/`
  (for example `bpy.ops.export_scene.html`, `bpy.types.Material.html`). When a bpy call errors or a name may have
  changed between versions, look it up there (or print `help(...)` from Blender's own Python) instead of guessing.

## Workflow
1. **Rules first.** Read the project's MASTER.md and LOG.md for asset rules: format, axes, facing, size, triangle budget,
   required material names, how the game recolours or animates it, camera distance and angle. Write them as a checklist.
2. **Design for the game view.** Seen small and from above means: a strong silhouette, chunky proportions (big head,
   shoulders, feet), a few large shapes instead of fine detail, and identity or team colour on **top-facing** surfaces
   (helmet, shoulders, back), not only on the front.
3. **One rebuildable build script** in the project (`tools/build_<name>.py`), no manual steps:
   - Model facing **-Y** in Blender (front view); the glTF exporter turns that into +Z with Y up.
   - Join parts, apply all transforms, then **normalise in code**: feet on z = 0, centred on x/y, exact height.
   - Print triangle count and size on every build.
   - Materials: Principled BSDF only (glTF keeps base colour, metallic, roughness, emission). Name them exactly as the
     project requires (for example `Team`). Two to four materials is plenty.
   - Export: `bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=True, export_yup=True)`.
4. **Check it in the game's renderer.** Load the GLB in the project's three.js viewer (or a tiny page using GLTFLoader)
   in headless Edge at the game's real camera distance with every team colour, screenshot it, open the screenshot and
   look. Blender renders differ: its default AgX view transform washes out emissive colours, three.js does not.
5. **Improve in rounds.** After each game-view screenshot, list what reads poorly at game size (thin limbs, dark
   masses, tiny glow areas, shapes merging) and fix it. Do at least two rounds; stop when the list is empty.
   - **Contrast with the board:** on a dark board, near-black armour vanishes and only the glow parts show. Keep the
     main body a clearly lighter mid-tone than the board, and check the silhouette is visible apart from the glow.
   - **Every side:** look at front, side, back and top. A flat pure-black face (unlit material, flipped normals,
     emission-only material) reads as a hole; fix it.
6. **Preview render.** Use `view_transform = 'Standard'` so colours match the game. Compute the framing, never guess
   angles: aim the camera at the bounds centre (`(target - cam.location).to_track_quat('-Z', 'Y')`) and size an
   orthographic camera from the bounds plus a margin. Open the image and check nothing is cropped.
7. **Verify by measurement.** From the exported file (load it back in three.js or Blender): triangles, height, lowest
   point, centre, material names, file size, no cameras or lights. Report the numbers against the project's rules.

## Using the model in a three.js game
1. **Team colours must survive the renderer.** Keep `renderer.toneMapping = THREE.NoToneMapping` (three's default)
   for neon games with glowing team parts. ACES or AgX tone mapping pushes bright emissive colours toward **white**, so
   cyan and magenta units both turn grey-white and teams can no longer be told apart. If you want a tone mapper for the
   rest of the scene, lower the Team `emissiveIntensity` (about 0.5) and prove the hue survives (step 5).
   A GLB's emission strength arrives as `emissiveIntensity` (Blender strength 2 → 2.0); check it before adding more glow.
2. **Recolouring:** `gltf.scene.clone(true)` shares materials, so recolouring one clone recolours them all. Make one
   Team material per team (clone the model's `Team` material once per team, set `color` and `emissive`) and assign it
   to each unit's Team meshes. Shared per-team materials are also the fastest option.
3. **Rules first, visuals catch up.** Apply the rules at once (HUD and state correct immediately) and play the
   animation from the events with a small tween timeline. If the player clicks during an animation, snap the board to
   the true state (remove units that left their squad lists) before starting the next one, so input never waits.
4. **Make the action readable:** units turn to face where they walk and bob as they march, the squad left behind
   closes ranks, defenders visibly fall before the tile changes owner, and formations are centred on their tile for
   any troop count. After every animation the number of models on a tile equals its troop count.
5. **Check it like a player, and measure colour.** Click the real buttons in headless Edge and take a burst of
   screenshots (every ~100 ms through an attack); open the mid-march, clash and after frames and look. Then sample the
   pixels of the units in a screenshot: the team parts must read as the team hue (cyan / magenta), not white or grey.

## Done means
The GLB loads in the game's renderer with no errors, every asset rule is met by measurement, the game-view screenshot
reads clearly for every team colour, and the preview shows the whole model uncropped.
