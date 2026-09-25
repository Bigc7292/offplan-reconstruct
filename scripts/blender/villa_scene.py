# Runs INSIDE Blender (sent through the Blender MCP's execute_blender_code tool by render_job.py).
#
# Turns a reconstructed job (exports/model.glb + scene-graph.json) into buyer-facing renders:
# the finishes stay the documented / render-sampled colours from the dossier, and only the
# surface *character* is added (stone joints and veining, wood planks, glass, water, fabric),
# under a physically based daylight sky. Nothing is added to the geometry: no rooms, walls,
# windows or furniture that the model does not already contain.
#
# Entry points (each call must finish inside the MCP's 180 s socket timeout):
#   setup(job_dir)            import the model, restyle materials, build sky, site and render settings
#   shots(job_dir) -> list    the camera list, as JSON-able dicts
#   render_shot(job_dir, i)   render shot i to job_dir/renders/{name}.png
import bpy
import json
import math
import os
from mathutils import Vector

RES = (1440, 900)


def _graph(job_dir):
    with open(os.path.join(job_dir, "scene-graph.json")) as f:
        return json.load(f)


def _clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.images, bpy.data.node_groups, bpy.data.worlds):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def _principled(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    return nt, bsdf


def _base_color(bsdf):
    c = bsdf.inputs["Base Color"].default_value
    return (c[0], c[1], c[2], 1.0)


def _scale(c, k):
    return (min(1, c[0] * k), min(1, c[1] * k), min(1, c[2] * k), 1.0)


def _uv(nt):
    n = nt.nodes.new("ShaderNodeTexCoord")
    return n.outputs["UV"]


def _stone(nt, bsdf, base, tiles=True):
    """Large-format stone: soft veining plus 2 mm joints on a 1.2 x 0.6 m grid (UVs are metres)."""
    uv = _uv(nt)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 9
    noise.inputs["Distortion"].default_value = 2.5
    nt.links.new(uv, noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.46
    ramp.color_ramp.elements[0].color = _scale(base, 0.86)
    ramp.color_ramp.elements[1].position = 0.52
    ramp.color_ramp.elements[1].color = base
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    col = ramp.outputs["Color"]
    if tiles:
        brick = nt.nodes.new("ShaderNodeTexBrick")
        brick.offset = 0.5
        brick.inputs["Scale"].default_value = 1.0
        brick.inputs["Brick Width"].default_value = 1.2
        brick.inputs["Row Height"].default_value = 0.6
        brick.inputs["Mortar Size"].default_value = 0.003
        brick.inputs["Color1"].default_value = (1, 1, 1, 1)
        brick.inputs["Color2"].default_value = (0.97, 0.97, 0.97, 1)
        brick.inputs["Mortar"].default_value = (0.55, 0.55, 0.55, 1)
        nt.links.new(uv, brick.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(col, mix.inputs[6])
        nt.links.new(brick.outputs["Color"], mix.inputs[7])
        col = mix.outputs[2]
    nt.links.new(col, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.16
    bsdf.inputs["Coat Weight"].default_value = 0.25


def _wood(nt, bsdf, base):
    """Engineered planks 0.19 m wide with grain; colour stays the sampled floor colour."""
    uv = _uv(nt)
    brick = nt.nodes.new("ShaderNodeTexBrick")
    brick.offset = 0.37
    brick.inputs["Scale"].default_value = 1.0
    brick.inputs["Brick Width"].default_value = 1.4
    brick.inputs["Row Height"].default_value = 0.19
    brick.inputs["Mortar Size"].default_value = 0.0015
    brick.inputs["Color1"].default_value = base
    brick.inputs["Color2"].default_value = _scale(base, 0.86)
    brick.inputs["Mortar"].default_value = _scale(base, 0.55)
    nt.links.new(uv, brick.inputs["Vector"])
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.inputs["Scale"].default_value = 18
    wave.inputs["Distortion"].default_value = 6
    wave.inputs["Detail"].default_value = 4
    nt.links.new(uv, wave.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 0.18
    nt.links.new(brick.outputs["Color"], mix.inputs[6])
    nt.links.new(wave.outputs["Color"], mix.inputs[7])
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.42


def _restyle(mat):
    name = mat.name.lower()
    nt, bsdf = _principled(mat)
    base = _base_color(bsdf)
    alpha = bsdf.inputs["Alpha"].default_value
    bsdf.inputs["Alpha"].default_value = 1.0
    if "water" in name:
        bsdf.inputs["Base Color"].default_value = (0.18, 0.55, 0.62, 1)
        bsdf.inputs["Transmission Weight"].default_value = 0.85
        bsdf.inputs["Roughness"].default_value = 0.03
        bsdf.inputs["IOR"].default_value = 1.33
        bump = nt.nodes.new("ShaderNodeBump")
        wav = nt.nodes.new("ShaderNodeTexNoise")
        wav.inputs["Scale"].default_value = 3
        bump.inputs["Strength"].default_value = 0.15
        nt.links.new(wav.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    elif "glaz" in name or "glass" in name or alpha < 0.99:
        bsdf.inputs["Base Color"].default_value = (0.9, 0.95, 0.96, 1)
        bsdf.inputs["Transmission Weight"].default_value = 1.0
        bsdf.inputs["Roughness"].default_value = 0.01
        bsdf.inputs["IOR"].default_value = 1.45
    elif "frame" in name or "bronze" in name or "brass" in name or "steel" in name:
        bsdf.inputs["Metallic"].default_value = 0.85
        bsdf.inputs["Roughness"].default_value = 0.35
    elif any(k in name for k in ("soft furnishing", "fabric", "carpet", "linen", "cushion", "throw")):
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Sheen Weight"].default_value = 0.6
        bsdf.inputs["Sheen Roughness"].default_value = 0.4
    elif "brushed metal" in name:
        bsdf.inputs["Metallic"].default_value = 1.0
        bsdf.inputs["Roughness"].default_value = 0.28
    elif "timber legs" in name:
        bsdf.inputs["Roughness"].default_value = 0.45
    elif "sanitary" in name or "ceramic" in name:
        bsdf.inputs["Base Color"].default_value = (0.93, 0.93, 0.92, 1)
        bsdf.inputs["Roughness"].default_value = 0.08
        bsdf.inputs["Coat Weight"].default_value = 0.6
    elif any(k in name for k in ("chevron", "herringbone", "parquet", "wood floor", "wood flooring")):
        _wood(nt, bsdf, base)
    elif "floor" in name and any(k in name for k in ("marble", "stone", "tile", "porcelain", "concrete", "paving")):
        _stone(nt, bsdf, base, tiles=True)
    elif any(k in name for k in ("marble", "stone slab", "quartz")):
        _stone(nt, bsdf, base, tiles=False)
    elif any(k in name for k in ("veneer", "wood", "walnut", "oak", "joinery", "lacquer", "cabinet")):
        bsdf.inputs["Roughness"].default_value = 0.4
    elif "slab" in name:
        bsdf.inputs["Roughness"].default_value = 0.9
    else:
        bsdf.inputs["Roughness"].default_value = max(0.6, bsdf.inputs["Roughness"].default_value)
    mat.blend_method = "OPAQUE" if hasattr(mat, "blend_method") else None


def _sky(dusk=False):
    """Physical sky for the light; the camera sees a clean blue gradient (a hazy Nishita horizon reads as brown)."""
    world = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(8 if dusk else 38)
    sky.sun_rotation = math.radians(215)
    sky.air_density = 1.0
    sky.dust_density = 0.3
    sky.sun_disc = False
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.22
    # camera rays: vertical gradient, pale at the horizon, clear blue overhead
    grad_bg = nt.nodes.new("ShaderNodeBackground")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.93, 0.78, 0.66, 1) if dusk else (0.86, 0.9, 0.94, 1)
    ramp.color_ramp.elements[1].position = 0.45
    ramp.color_ramp.elements[1].color = (0.32, 0.36, 0.55, 1) if dusk else (0.36, 0.58, 0.86, 1)
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], grad_bg.inputs["Color"])
    grad_bg.inputs["Strength"].default_value = 0.9 if dusk else 1.0
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg.outputs["Background"], mix.inputs[1])
    nt.links.new(grad_bg.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 1.2 if dusk else 2.4
    sun.angle = math.radians(1.2)
    sun.color = (1.0, 0.72, 0.5) if dusk else (1.0, 0.96, 0.9)
    so = bpy.data.objects.new("Sun", sun)
    so.rotation_euler = (math.radians(90 - (8 if dusk else 38)), 0, math.radians(215 - 180))
    bpy.context.scene.collection.objects.link(so)


def _site(g):
    street = min(g["levels"], key=lambda l: abs(l["elevationM"]))
    z = street["elevationM"] - 0.07
    b = g["bounds"]
    cx, cy = (b["min"]["x"] + b["max"]["x"]) / 2, -(b["min"]["z"] + b["max"]["z"]) / 2
    for name, size, col, rough, dz in (("Lawn", 1600, (0.16, 0.26, 0.09, 1), 1.0, -0.01),):
        if size is None:
            sx, sy = b["max"]["x"] - b["min"]["x"] + 4, b["max"]["z"] - b["min"]["z"] + 4
        else:
            sx = sy = size
        bpy.ops.mesh.primitive_plane_add(size=1, location=(cx, cy, z + dz))
        o = bpy.context.active_object
        o.name = name
        o.scale = (sx, sy, 1)
        m = bpy.data.materials.new(name)
        nt, bsdf = _principled(m)
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = rough
        if name == "Lawn":
            noise = nt.nodes.new("ShaderNodeTexNoise")
            noise.inputs["Scale"].default_value = 240
            ramp = nt.nodes.new("ShaderNodeValToRGB")
            ramp.color_ramp.elements[0].color = (0.12, 0.2, 0.07, 1)
            ramp.color_ramp.elements[1].color = (0.22, 0.33, 0.12, 1)
            nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
            nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        o.data.materials.append(m)


def setup(job_dir, dusk=False):
    _clear()
    bpy.ops.import_scene.gltf(filepath=os.path.join(job_dir, "exports", "model.glb"))
    for m in bpy.data.materials:
        _restyle(m)
    g = _graph(job_dir)
    _site(g)
    _sky(dusk)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 40
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.03
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.cycles.transparent_max_bounces = 8
    sc.render.resolution_x, sc.render.resolution_y = RES
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.render.film_transparent = False
    sc.view_settings.exposure = -0.2
    print(f"setup ok: {len(bpy.data.objects)} objects, {len(bpy.data.materials)} materials")


def _meta(o):
    """levelId / layer from the glTF node extras, else from the node name 'level/material/layer'."""
    lvl = o.get("levelId")
    layer = o.get("layer")
    if lvl is None and "/" in o.name:
        parts = o.name.split("/")
        lvl, layer = parts[0], parts[2].split(".")[0] if len(parts) > 2 else None
    return lvl, layer


def _viewpoint(poly):
    xs = [p["x"] for p in poly]
    ys = [p["y"] for p in poly]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    w, d = maxx - minx, maxy - miny

    def inside(x, y):
        c = False
        j = len(poly) - 1
        for i in range(len(poly)):
            xi, yi, xj, yj = poly[i]["x"], poly[i]["y"], poly[j]["x"], poly[j]["y"]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi:
                c = not c
            j = i
        return c

    tries = [((minx + 0.12 * w, cy), (1, 0)), ((maxx - 0.12 * w, cy), (-1, 0))] if w >= d else [((cx, miny + 0.12 * d), (0, 1)), ((cx, maxy - 0.12 * d), (0, -1))]
    for (x, y), dirv in tries:
        if inside(x, y):
            return x, y, dirv
    return cx, cy, (1, 0) if w >= d else (0, 1)


def shots(job_dir):
    g = _graph(job_dir)
    levels = sorted(g["levels"], key=lambda l: l["elevationM"])
    out = [
        {"name": "exterior", "kind": "exterior", "title": "The villa from above"},
        {"name": "exterior-garden", "kind": "exterior", "view": "garden", "title": "The villa from the garden"},
    ]
    for l in levels:
        out.append({"name": f"cutaway-{l['id']}", "kind": "cutaway", "level": l["id"], "title": f"{l['name']}: layout"})
    rooms = [r for r in g["rooms"] if r["program"] not in ("balcony", "circulation", "storage") and len(r["polygon"]) >= 3]
    picked = []
    for prog in ("living", "kitchen", "bedroom"):
        cands = sorted([r for r in rooms if r["program"] == prog and r["computedAreaM2"] >= 9], key=lambda r: -r["computedAreaM2"])
        picked += cands[:2 if prog != "kitchen" else 1]
    for r in picked:
        lvl = next(l for l in levels if l["id"] == r["levelId"])
        out.append({"name": f"room-{r['id']}", "kind": "interior", "level": r["levelId"], "room": r["id"], "title": f"{r['name']} ({lvl['name']})"})
    return out


def _camera(loc, target, lens):
    cam = bpy.data.cameras.new("Cam")
    cam.lens = lens
    cam.clip_start = 0.05
    o = bpy.data.objects.new("Cam", cam)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    direction = Vector(target) - Vector(loc)
    o.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = o
    return o


def render_shot(job_dir, i):
    g = _graph(job_dir)
    shot = shots(job_dir)[i]
    for o in list(bpy.data.objects):
        if o.name.startswith("Cam") or o.name.startswith("RoomLight"):
            bpy.data.objects.remove(o, do_unlink=True)
    elev = {l["id"]: l["elevationM"] for l in g["levels"]}
    b = g["bounds"]
    cx, cy = (b["min"]["x"] + b["max"]["x"]) / 2, -(b["min"]["z"] + b["max"]["z"]) / 2
    size = max(b["max"]["x"] - b["min"]["x"], b["max"]["z"] - b["min"]["z"])
    sc = bpy.context.scene
    sc.cycles.samples = 40
    for o in bpy.data.objects:
        lvl, layer = _meta(o)
        if lvl is None:
            continue
        hide = False
        if shot["kind"] == "cutaway":
            hide = elev.get(lvl, 0) > elev[shot["level"]] + 1e-6 or (layer == "ceiling" and lvl == shot["level"])
        elif shot["kind"] == "exterior":
            hide = elev.get(lvl, 0) < -0.01  # the basement is underground
        o.hide_render = hide
    lawn = bpy.data.objects.get("Lawn")
    if lawn:
        # a basement cut-away looks down through the ground
        lawn.hide_render = shot["kind"] == "cutaway" and elev[shot["level"]] < -0.01
    if shot["kind"] == "exterior" and shot.get("view") == "garden":
        # eye level from beyond the largest ground-level outdoor space (pool, garden, terrace), facing the house
        top = max(l["elevationM"] + l["heightM"] for l in g["levels"])
        street = min(g["levels"], key=lambda l: abs(l["elevationM"]))
        outs = [r for r in g["rooms"] if r["levelId"] == street["id"] and (r["program"] == "balcony" or any(k in r["name"].lower() for k in ("pool", "garden", "terrace", "deck", "lawn")))]
        inside = [r for r in g["rooms"] if r["levelId"] == street["id"] and r not in outs]
        hx = sum(r["centroid"]["x"] for r in inside) / max(1, len(inside)) if inside else cx
        hy = -sum(r["centroid"]["z"] for r in inside) / max(1, len(inside)) if inside else cy
        if outs:
            o = max(outs, key=lambda r: r["computedAreaM2"])
            ox, oy = o["centroid"]["x"], -o["centroid"]["z"]
        else:
            ox, oy = hx + size, hy - size
        dx, dy = ox - hx, oy - hy
        L = math.hypot(dx, dy) or 1
        dx, dy = dx / L, dy / L
        # step 30 degrees round so the facade is seen in perspective, not flat on
        a = math.radians(30)
        dx, dy = dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)
        dist = max(L + 8, size * 1.05)
        _camera((hx + dx * dist, hy + dy * dist, street["elevationM"] + 2.2), (hx, hy, street["elevationM"] + top * 0.32), 24)
    elif shot["kind"] == "exterior":
        top = max(l["elevationM"] + l["heightM"] for l in g["levels"])
        _camera((cx + size * 0.62, cy + size * 0.92, top + size * 0.2), (cx, cy, top * 0.35), 30)
    elif shot["kind"] == "cutaway":
        z = elev[shot["level"]]
        rooms = [r for r in g["rooms"] if r["levelId"] == shot["level"]]
        xs = [p["x"] for r in rooms for p in r["polygon"]]
        ys = [p["y"] for r in rooms for p in r["polygon"]]
        lx, ly = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        s = max(max(xs) - min(xs), max(ys) - min(ys))
        _camera((lx + s * 0.55, ly - s * 0.75, z + s * 1.05), (lx, ly, z), 35)
    else:
        r = next(x for x in g["rooms"] if x["id"] == shot["room"])
        z = elev[r["levelId"]]
        x, y, (dx, dy) = _viewpoint(r["polygon"])
        _camera((x, y, z + 1.45), (x + dx * 4, y + dy * 4, z + 1.2), 18)
        # the ceiling cove / downlight wash the renders show, as a soft area light under the ceiling
        xs = [p["x"] for p in r["polygon"]]
        ys = [p["y"] for p in r["polygon"]]
        light = bpy.data.lights.new("RoomLight", "AREA")
        light.shape = "RECTANGLE"
        light.size, light.size_y = max(1, max(xs) - min(xs) - 0.6), max(1, max(ys) - min(ys) - 0.6)
        light.energy = 14 * (max(xs) - min(xs)) * (max(ys) - min(ys))
        light.color = (1.0, 0.9, 0.78)
        lo = bpy.data.objects.new("RoomLight", light)
        lo.location = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, z + r["ceilingHeightM"] - 0.08)
        sc.collection.objects.link(lo)
        sc.cycles.samples = 48
    os.makedirs(os.path.join(job_dir, "renders"), exist_ok=True)
    sc.render.filepath = os.path.join(job_dir, "renders", f"{shot['name']}.png")
    bpy.ops.render.render(write_still=True)
    print(f"rendered {shot['name']}")
    return shot
