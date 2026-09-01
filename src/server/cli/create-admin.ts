import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashPassword } from "better-auth/crypto";

import { UserRole, UserStatus } from "@/generated/prisma/client";
import { internalEmailForUsername, validateCredentials } from "@/server/auth/user-policy";
import { getPrismaClient } from "@/server/db/client";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("admin:create requires an interactive TTY");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        finish();
        reject(new Error("Cancelled"));
      } else if (text === "\r" || text === "\n") {
        finish();
        resolve(value);
      } else if (text === "\u007f") {
        value = value.slice(0, -1);
      } else if (/^[\x20-\x7E]+$/.test(text)) {
        value += text;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(chunk.toString("utf8").trim());
    });
  });
}

export async function createInitialAdmin(): Promise<void> {
  if (process.argv.some((argument) => /password/i.test(argument))) {
    throw new Error("Password arguments are forbidden; use the interactive prompt");
  }
  const prisma = getPrismaClient();
  if ((await prisma.user.count()) !== 0) {
    throw new Error("Initial administrator can only be created in an empty user database");
  }
  const usernameValue = await readLine("Username: ");
  const passwordValue = await readHidden("Password: ");
  const confirmation = await readHidden("Confirm password: ");
  if (passwordValue !== confirmation) throw new Error("Passwords do not match");
  const { username, password } = validateCredentials(usernameValue, passwordValue);
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (transaction) => {
    await transaction.user.create({
      data: {
        id: userId,
        name: username,
        email: internalEmailForUsername(username),
        emailVerified: true,
        username,
        role: UserRole.admin,
        status: UserStatus.active,
      },
    });
    await transaction.account.create({
      data: {
        id: randomUUID(),
        accountId: userId,
        providerId: "credential",
        issuer: "local:credential",
        userId,
        password: passwordHash,
      },
    });
  });
  process.stdout.write(`Administrator ${username} created.\n`);
  await prisma.$disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createInitialAdmin().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to create administrator"}\n`);
    process.exitCode = 1;
  });
}
