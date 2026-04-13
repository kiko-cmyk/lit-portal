import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rewrite all non-internal paths to /api/proxy
  const url = request.nextUrl.clone();
  url.pathname = `/api/proxy${pathname === '/' ? '' : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next|api|favicon\\.ico).*)'],
};
