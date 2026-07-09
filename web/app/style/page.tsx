import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import TopBar from "@/components/TopBar";
import StyleEditor from "@/components/StyleEditor";

export default async function StylePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex flex-col h-screen">
      <TopBar username={session.username} role={session.role} />
      <div className="scroll flex-1">
        <StyleEditor role={session.role} />
      </div>
    </div>
  );
}
