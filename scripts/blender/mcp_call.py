"""Call one tool on the Blender MCP server (mcp-for-blender) from the command line.

    uv run --with mcp scripts/blender/mcp_call.py <tool> '<json args>'
    uv run --with mcp scripts/blender/mcp_call.py --list

This is the same server .mcp.json registers for Claude Code. It is useful from scripts, and in a
session that started before the server was added (Claude Code only loads MCP servers at start-up).
Blender must be running with the MCP add-on connected (see docs/blender.md).
"""
import asyncio, json, os, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    env = {**os.environ, "DISABLE_TELEMETRY": "true"}
    params = StdioServerParameters(command="uvx", args=["mcp-for-blender"], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            if sys.argv[1] == "--list":
                for t in (await s.list_tools()).tools:
                    print(f"{t.name}: {(t.description or '').splitlines()[0][:110]}")
                return
            args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
            if "code_file" in args:
                args["code"] = open(args.pop("code_file")).read()
            res = await s.call_tool(sys.argv[1], args)
            for c in res.content:
                print(getattr(c, "text", c))
            if getattr(res, "is_error", getattr(res, "isError", False)):
                sys.exit(1)


asyncio.run(main())
