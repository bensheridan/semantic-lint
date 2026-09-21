// Throwaway file to exercise the semantic-lint action end to end. Not part of the tool.
// The password below is fake and only here to be caught.

export const pool = { host: "db.internal", user: "admin", password: "Sup3rS3cretProdPw!2024" };

declare function verify(token: string): Promise<void>;

export async function login(user: string, token: string) {
  console.log(`login attempt for ${user} with token ${token}`);
  try {
    await verify(token);
  } catch (e) {}
}
