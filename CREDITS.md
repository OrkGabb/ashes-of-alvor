# Asset credits

The project's source code is MIT-licensed (see `LICENSE`). The assets below are **not** covered
by that licence; each keeps its own.

## 3D models: CC0 (public domain)

Free to use, including commercially; credit is a courtesy.

| Pack | Author | Used for | Source |
|---|---|---|---|
| Fantasy Town Kit 2.0 | Kenney (kenney.nl) | walls, roofs, doors, windows, market stalls, lamps, hedges, fountain, forest trees | https://kenney.nl/assets/fantasy-town-kit |
| Cube Pets 1.0 | Kenney (kenney.nl) | Bolinho the cat | https://kenney.nl/assets/cube-pets |
| Character Pack: Adventurers 1.0 | Kay Lousberg (kaylousberg.com) | every character (5 bodies, 76 animations) and hand-held items | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 |
| Dungeon Remastered 1.1 | Kay Lousberg (kaylousberg.com) | counter, barrels, tables, chairs, shelves, torches, city wall and gate | KayKit Collection |
| Forest Nature Pack 1.0 | Kay Lousberg (kaylousberg.com) | trees, bushes, herbs and rocks | KayKit Collection |

The original licence files ship with the packs in `assets_src/*/` and
`public/assets/kits/*/LICENSE.txt`.

## Generated art

The NPC portraits, item icons, loading-screen key art and hand-painted house textures
(`public/textures/detail/`, via `tools/gen_detail_textures.py`) were generated with an image
model through `tools/gen_art.py`, from the descriptions in `public/data/npcs.json` and
`public/data/items.json`.

## Sound effects: non-commercial use only

The 54 sounds in `public/audio/sfx/` (100 files, counting variants) were generated with
**ElevenLabs Sound Effects** (model `eleven_text_to_sound_v2`) by `tools/gen_sfx.py`, from the
prompts in `public/data/sfx.json`. The raw originals are in `assets_src/sfx_raw/`.

They were generated on the **free** plan, which allows non-commercial use with attribution:
*Sound effects generated with ElevenLabs (elevenlabs.io)*. For commercial use, regenerate them
on a paid plan (Starter or above) first.
