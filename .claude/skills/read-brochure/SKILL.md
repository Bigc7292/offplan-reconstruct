---
name: read-brochure
description: Read an off-plan brochure PDF (or listing URL) inside Claude Code, with no model API key, and turn it into a walkable 3D model in the OffPlan Reconstruct app. Use when asked to read, reconstruct, or model a brochure.
---

# Read a brochure with Claude Code

The app normally sends each page to a vision model. Here **you are the vision model**: the app writes one
request per task into the job folder, you answer each one by looking at the images and writing JSON, and
the app validates every answer against the same Zod schema a model reply would have to pass.

## 1. Start the job

```bash
npm run cc -- new "/path/to/brochure.pdf" --unit "Villa 8"      # also accepts extra PDFs, images or https:// listing URLs
```

It prints the job id and a TODO list of request folders under `data/jobs/<id>/claude-code/`. Each folder has
`request.md` (instructions and prompt), `schema.json` (the exact shape to return) and `image-N.png` (the images,
exactly as a model would see them; pixel coordinates refer to these files).

## 2. Answer the requests

Write `answer.json` in each folder: one JSON object matching `schema.json`, nothing else. Rules that matter:

- **Be faithful.** Quote printed text exactly. Never invent a room, window, area or finish the page does not show.
  Unlabelled space is named "Circulation (unlabelled)", never given a made-up name.
- **classify-page-*:** all labels that apply; a page with floor plans must include `unit_plan`.
- **facts:** every number with its exact quote and `page-N` ref; prices "as printed".
- **materials-*:** 3-6 surfaces you can actually see. `albedoHex` is the surface's own colour under neutral white
  light (compensate for render shading: white paint or white marble is light, ~80-95% lightness), not the shaded
  pixel average. Skip loose rugs. Glass is neutral (#c9d6d8). Only name a stone or wood species if it is written.
- **plan-*:** do not hand-write walls. Write `plan-sketch.json` next to the request instead, then run
  `npm run cc -- sketch data/jobs/<id>/claude-code/<plan folder>`. It derives walls from the room outlines,
  snaps openings to them, writes `answer.json`, prints traced vs printed areas and draws `sketch-overlay.png`.
  **Look at the overlay** and fix the sketch until it sits on the drawing. Sketch format (all in image pixels):

  ```json
  {
    "levelName": "GROUND FLOOR",
    "pxPerMeter": 26.5,
    "scaleSource": "GUEST BEDROOM 4.3 X 4.3 is 110 px wide",
    "scaleConfidence": 0.65,
    "anchor": { "px": [200, 715], "m": [10, 8] },
    "rooms": [
      { "name": "Family Lounge", "program": "living", "rect": [100, 305, 283, 460], "printed": "6.9 X 4.8" },
      { "name": "Double Height", "program": "circulation", "poly": [[270,460],[338,460],[338,700],[270,700]] },
      { "name": "Swimming Pool", "program": "balcony", "rect": [195, 62, 462, 165], "open": true }
    ],
    "glass": [[[100, 305], [480, 305]]],
    "openEdges": [[[283, 305], [283, 460]]],
    "openings": [{ "kind": "sliding_door", "at": [165, 305], "widthM": 2.6 }],
    "furniture": [{ "kind": "sofa", "center": { "x": 183, "y": 331 }, "w": 80, "d": 22, "rotationDeg": 0 }]
  }
  ```

  - `pxPerMeter`: measure a room whose size is printed ("4.3 X 4.3") and check two or three more.
  - `anchor`: the same physical point on every floor (a corner of the lift shaft or stair core) with the same
    building metres on every floor. **Without it the floors will not stack.**
  - `glass`: façade segments drawn as glazing. `openEdges`: open-plan boundaries (no wall between rooms).
  - `open: true`: ground-level pool, garden or deck (no railing round it). Terraces upstairs keep railings.
  - `furniture`: only pieces drawn on the plan. `rotationDeg` 0 puts a bed's headboard / sofa's back at the top
    of the image; 90 = left, -90 = right, 180 = bottom.
  - `npm run cc -- zoom <image.png> x0 y0 x1 y1` enlarges a region with a pixel grid for reading small print
    and measuring. Use it: plan text is tiny.

You can split the answering across subagents (for example one for classification and facts, one for renders)
while you trace the plans yourself. `npm run cc -- check <id>` validates answers without re-running anything.

## 3. Re-run, then build

```bash
npm run cc -- next <id>     # applies the answers; may add new requests (e.g. a page newly recognised as a plan)
npm run cc -- build <id>    # builds the 3D model and GLB, prints the links
```

Repeat step 2 for any new TODOs. Then run the app (`npm run build && npm start`, or `npm run dev`) and open the
printed links: `/jobs/<id>` to review and correct, `/jobs/<id>/model` to walk it, `/view/<id>` to share it.

## 4. Renders (optional, needs Blender)

With Blender running and the Blender MCP connected (`.mcp.json`, see `docs/blender.md`):

```bash
uv run --with mcp scripts/blender/render_job.py <id>
```

renders the exterior, a cut-away of every floor and the main rooms. They appear in the app as "Rendered views".

## 5. Critique

Take screenshots with `npm run screenshots -- <id>` and ask the `critic-agent` subagent to score them. Fix what it
lists and repeat until it scores 8.5 or higher.
