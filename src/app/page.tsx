import { redirect } from "next/navigation";

// Root → Hub. The portal anchor is /your-lit per Master Spec § 3.3.
export default function Root() {
  redirect("/your-lit");
}
