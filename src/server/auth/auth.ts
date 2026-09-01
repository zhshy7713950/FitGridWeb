import { randomUUID } from "node:crypto";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { username } from "better-auth/plugins";

import type { PrismaClient } from "@/generated/prisma/client";
import { getPrismaClient } from "@/server/db/client";

export function createAuth(prisma: PrismaClient) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  return betterAuth({
    appName: "F.I.T Grid Web",
    baseURL: process.env.BETTER_AUTH_URL,
    basePath: "/api/v1/auth/internal",
    secret,
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "member",
          input: false,
        },
        status: {
          type: "string",
          required: true,
          defaultValue: "active",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    disabledPaths: ["/sign-up/email", "/sign-in/email", "/is-username-available"],
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 64,
        immutableUsername: true,
        displayUsername: false,
        usernameNormalization: (value) => value.trim().toLowerCase(),
        usernameValidator: (value) => /^[a-z0-9._]+$/.test(value),
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (!user || user.status !== "active") {
              throw new APIError("UNAUTHORIZED", { message: "Invalid username or password" });
            }
            return { data: session };
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "fitgridweb",
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      },
      database: {
        generateId: () => randomUUID(),
      },
    },
    telemetry: { enabled: false },
  });
}

export type FitGridAuth = ReturnType<typeof createAuth>;

let authInstance: FitGridAuth | undefined;

export function getAuth(): FitGridAuth {
  authInstance ??= createAuth(getPrismaClient());
  return authInstance;
}
