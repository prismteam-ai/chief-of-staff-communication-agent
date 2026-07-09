import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import TopBar from "@/components/TopBar";
import Workspace from "@/components/Workspace";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex flex-col h-screen">
      <TopBar username={session.username} role={session.role} />
      <Workspace role={session.role} />
    </div>
  );
}
