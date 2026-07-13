import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import KnowledgeView from "@/components/KnowledgeView";

export default async function KnowledgePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader
        email={session.user.email}
        active="/knowledge"
        subtitle="What your agents know"
      />
      <div className="mx-auto max-w-7xl px-6 py-8">
        <KnowledgeView />
      </div>
    </main>
  );
}
