import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import TopBar from "@/components/TopBar";
import Connections from "@/components/Connections";

export default async function ConnectionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex flex-col h-screen">
      <TopBar username={session.username} role={session.role} />
      <div className="scroll flex-1">
        <Connections role={session.role} />
      </div>
    </div>
  );
}
