import { NextResponse } from "next/server";
import { withNo404Headers } from "@no404/node/next/proxy";

// Hands the original URL to app/not-found.js (Next 15: name this file middleware.js).
export function proxy(request) {
  return NextResponse.next({ request: { headers: withNo404Headers(request) } });
}

export const config = {
  matcher: ["/((?!_next/|api/|favicon.ico).*)"],
};
