// Demo file for the semantic-lint check. Do not merge. Not part of the tool.

declare function verify(token: string): Promise<void>;

export async function login(user: string, token: string) {
  console.log(`login attempt for ${user} with token ${token}`);
  await verify(token);
}
