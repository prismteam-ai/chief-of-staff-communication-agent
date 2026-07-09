import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { signToken, setSessionCookie } from "@/lib/session";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  const role = user.role === "owner" ? "owner" : "viewer";
  const token = await signToken({ username: user.username, role });
  await setSessionCookie(token);
  return NextResponse.json({ username: user.username, role });
}
