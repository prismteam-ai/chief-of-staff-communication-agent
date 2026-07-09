import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE = "cos_session";

function secret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s) throw new Error("AUTH_JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export type Session = { username: string; role: "owner" | "viewer" };

/** Mint the HS256 token the Python API also verifies (claims: sub, role). */
export async function signToken(session: Session): Promise<string> {
  return new SignJWT({ role: session.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.username)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      username: String(payload.sub),
      role: (payload.role as "owner" | "viewer") ?? "viewer",
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure cookies require HTTPS. Default to on in production, but allow an explicit
    // override (COOKIE_SECURE=false) for an HTTP-only deploy behind a firewall.
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}

/** Raw token (for forwarding to the Python API as a bearer). */
export async function getToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

export async function getSession(): Promise<Session | null> {
  const token = await getToken();
  return token ? verifyToken(token) : null;
}

export const SESSION_COOKIE = COOKIE;
