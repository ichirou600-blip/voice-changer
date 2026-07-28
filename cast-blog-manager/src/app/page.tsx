import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { isSetupCompleted } from "@/lib/auth/setup";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  if (!(await isSetupCompleted())) redirect("/setup");
  redirect((await getSessionUser()) ? "/dashboard" : "/login");
}
