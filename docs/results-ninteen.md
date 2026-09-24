# Ninteen Riviera Villa 8 on GPT 6 Astra (2026-09-24)

Input: the 14-page Ninteen Riviera sales deck (basement, ground, first and roof plans; room sizes are printed only inside the low-resolution plan images). The PDF itself is not in this repo.

## Result

- `PDF=... npm test` passed **13/13** acceptance checks with the model path on.
- All 14 pages were classified by the model.
- Key facts read correctly: built-up area 1,580 m², plot 869 m², 5 bedrooms, standalone B+G+2, service charge 2.5 AED/sq ft, handover January 2027. Prices are kept as "as printed, unconfirmed".
- Printed room sizes read correctly from the plan images, e.g. FAMILY LOUNGE 6.9 × 4.8, FORMAL LOUNGE 7.5 × 4.8, CAR WASHING BAY 5.4 × 7.2.
- 3 of 4 floors came back from the model with 51 rooms. The rooftop hit a gateway error and used the local extractor. The retry limit was raised afterwards.
- Traced room shapes are only roughly to scale (the plan scale is inferred). `rooms.csv` puts printed sizes next to traced areas; the gap closes once a reviewer runs "Calibrate scale" in the plan editor.

## Files in `backups/ninteen-gpt6-astra/`

| File | What it is |
|---|---|
| `ninteen-villa8.glb` | The 3D model. Opens in any GLB viewer (e.g. gltf-viewer.donmccurdy.com) |
| `2-3d-model.png` | Render of the model in the app's dollhouse view |
| `1-review.png` | The review screen: source page, dossier and plan editor |
| `3-share-view.png` | The public share page |
| `live-preview.png` | The live 3D preview shown while a brochure is being read |
| `rooms.csv` | Every room per floor: printed size, printed m², traced m² |
| `dossier.json` | The full Property Dossier: facts, levels, rooms, walls, finishes, with the page evidence for each |

`backups/acceptance-2026-09-24/` holds the screenshots and `results.json` from the original build's acceptance run on the built-in DEMO unit and Ninteen with the local extractor.

## Timing

| Run | Model calls | Wall time |
|---|---|---|
| One at a time (before 80c36a2) | 28 | about 14 min |
| 4 at a time (after 80c36a2) | 28 | 689 s, but spoiled by 502s, 400s and the balance running out mid-run |

A clean timing of the parallel version is still owed once the balance is topped up.
