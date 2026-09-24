// Optional site-wide password. When APP_PASSWORD is set, every page and API call asks for it
// (HTTP Basic auth, any user name), so a public deployment doesn't spend model credits for strangers.
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Password required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="OffPlan Reconstruct"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|icon.svg).*)"] };
