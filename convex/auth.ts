import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password({
    profile: (params) => {
      const email = String(params.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) throw new Error("Invalid email");
      // A workspace code prevents an unauthenticated caller from registering
      // the owner's email before the owner does. No email service is needed.
      if (params.flow === "signUp") {
        const code = process.env.COLONY_REGISTRATION_CODE;
        if (!code || params.workspaceCode !== code) throw new Error("Invalid workspace code");
        const owner = process.env.COLONY_OWNER_EMAIL?.trim().toLowerCase();
        if (owner && email !== owner) throw new Error("This workspace is private");
      }
      return { email, ...(params.flow === "signUp" ? { workspaceAccess: true } : {}) };
    },
  })],
});
