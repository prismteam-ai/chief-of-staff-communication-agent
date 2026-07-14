import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import ActionsView from "@/components/ActionsView";

export default async function ActionsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader
        email={session.user.email}
        active="/actions"
        subtitle="What your agents did and what needs you"
      />
      <div className="mx-auto max-w-5xl px-6 py-8">
        <ActionsView />
      </div>
    </main>
  );
}
