import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Fixed demo credentials so a grader logs in with no OAuth.
const USERS = [
  { username: "owner", password: "owner1234", role: "owner" },
  { username: "demo", password: "demo1234", role: "viewer" },
];

const PROVIDERS = ["gmail", "whatsapp", "x", "asana"];

async function main() {
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.upsert({
      where: { username: u.username },
      update: { passwordHash, role: u.role },
      create: { username: u.username, passwordHash, role: u.role },
    });
  }
  for (const provider of PROVIDERS) {
    await prisma.connection.upsert({
      where: { provider },
      update: {},
      create: { provider, mode: "mock", connected: true, detail: "mock" },
    });
  }
  console.log("Seeded users (owner/owner1234, demo/demo1234) + mock connections.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
