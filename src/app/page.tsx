import { redirect } from "next/navigation";

// Root → default-locale Hub. `src/proxy.ts` handles bare-path redirects in
// production; this is the build-time fallback so Next.js doesn't 404 on /.
export default function Root() {
  redirect("/es/tu-lit");
}
