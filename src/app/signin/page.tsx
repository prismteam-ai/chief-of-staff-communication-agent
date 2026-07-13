import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/connections");

  const googleReady = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const microsoftReady = Boolean(
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-2xl font-semibold text-white">Chief of Communications</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Sign in to connect your communication channels and let your AI chief of
          communications work across them.
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/connections" });
            }}
          >
            <button
              type="submit"
              disabled={!googleReady}
              className="w-full rounded-lg border border-neutral-700 bg-white px-4 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue with Google
            </button>
          </form>

          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: "/connections" });
            }}
          >
            <button
              type="submit"
              disabled={!microsoftReady}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue with Microsoft
            </button>
          </form>
        </div>

        {(!googleReady || !microsoftReady) && (
          <p className="mt-6 rounded-lg border border-amber-900 bg-amber-950/50 p-3 text-xs text-amber-300">
            {!googleReady && !microsoftReady
              ? "No sign-in providers are configured yet."
              : `${!googleReady ? "Google" : "Microsoft"} sign-in is not configured.`}{" "}
            Set the AUTH_* variables in .env — see docs/provider-setup.md for the
            registration steps.
          </p>
        )}
      </div>
    </main>
  );
}
