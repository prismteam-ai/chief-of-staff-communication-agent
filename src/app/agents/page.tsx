import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import AgentsView from "@/components/AgentsView";

export default async function AgentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader email={session.user.email} active="/agents" subtitle="AI agents" />
      <div className="mx-auto max-w-7xl px-6 py-8">
        <AgentsView />
      </div>
    </main>
  );
}
