import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import ApprovalsView from "@/components/ApprovalsView";

export default async function ApprovalsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader
        email={session.user.email}
        active="/approvals"
        subtitle="Agent actions & approvals"
      />
      <div className="mx-auto max-w-5xl px-6 py-8">
        <ApprovalsView />
      </div>
    </main>
  );
}
