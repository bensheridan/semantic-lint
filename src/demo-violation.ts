// Throwaway file to exercise the semantic-lint action end to end. Not part of the tool.
// This version is compliant: credentials come from the environment, nothing sensitive is
// logged, and the error is logged and rethrown.

export const pool = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

declare function verify(token: string): Promise<void>;

export async function login(user: string, token: string) {
  console.log(`login attempt for ${user}`);
  try {
    await verify(token);
  } catch (e) {
    console.error("token verification failed", e);
    throw e;
  }
}
