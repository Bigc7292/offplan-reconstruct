"""Render a finished job in Blender through the Blender MCP server.

    uv run --with mcp scripts/blender/render_job.py <jobId> [--only exterior,cutaway] [--dusk]

Needs Blender running with the MCP add-on (docs/blender.md). Every step goes through the MCP
server's execute_blender_code tool, the same path Claude Code uses when it drives Blender.
Writes data/jobs/{id}/renders/*.png and renders/index.json, which the app's model and share
pages show as "Rendered views".
"""
import asyncio, json, os, sys, time
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCENE_PY = os.path.join(ROOT, "scripts", "blender", "villa_scene.py")


async def main():
    job = sys.argv[1]
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1].split(",")
    dusk = "--dusk" in sys.argv
    data = os.environ.get("DATA_DIR") or os.path.join(ROOT, "data", "jobs")
    job_dir = os.path.abspath(os.path.join(data, job))
    if not os.path.exists(os.path.join(job_dir, "exports", "model.glb")):
        sys.exit(f"No exports/model.glb in {job_dir}: run `npm run cc -- build {job}` first.")
    pre = f"exec(open({SCENE_PY!r}).read())\n"
    params = StdioServerParameters(command="uvx", args=["mcp-for-blender"], env={**os.environ, "DISABLE_TELEMETRY": "true"})
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()

            async def run(code):
                res = await s.call_tool("execute_blender_code", {"code": pre + code})
                text = "".join(getattr(c, "text", "") for c in res.content)
                if getattr(res, "is_error", getattr(res, "isError", False)) or "Error" in text[:40]:
                    raise RuntimeError(text)
                return text

            print(await run(f"setup({job_dir!r}, dusk={dusk})"))
            out = await run(f"import json\nprint('SHOTS' + json.dumps(shots({job_dir!r})))")
            shots = json.loads(out.split("SHOTS", 1)[1].strip().splitlines()[0])
            done = []
            for i, shot in enumerate(shots):
                if only and shot["kind"] not in only and shot["name"] not in only:
                    continue
                t = time.time()
                print(await run(f"render_shot({job_dir!r}, {i})"), f"({time.time() - t:.0f} s)")
                done.append({**shot, "file": f"renders/{shot['name']}.png"})
    index_path = os.path.join(job_dir, "renders", "index.json")
    prev = []
    if only and os.path.exists(index_path):
        prev = [x for x in json.load(open(index_path))["shots"] if x["name"] not in {d["name"] for d in done}]
    order = {s["name"]: i for i, s in enumerate(shots)}
    all_shots = sorted(prev + done, key=lambda x: order.get(x["name"], 99))
    scene_hash = None
    try:
        scene_hash = json.load(open(os.path.join(job_dir, "scene-graph.json")))["dossierHash"]
    except Exception:
        pass
    json.dump({
        "dossierHash": scene_hash,  # the model version rendered: the app hides renders of an older model
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "engine": "Blender Cycles via the Blender MCP",
        "note": "Rendered from the reconstructed model. Colours are the brochure's; stone joints, wood planks and lighting are illustrative.",
        "shots": all_shots,
    }, open(index_path, "w"), indent=2)
    print(f"{len(done)} render(s) → {os.path.dirname(index_path)}")


asyncio.run(main())
