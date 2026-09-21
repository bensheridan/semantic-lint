// Demo file for the semantic-lint check. Do not merge. Not part of the tool.

export function checkToken(user: string, token?: string) {
  if (!token) {
    console.warn(`login for ${user} rejected: token missing`);
    return false;
  }
  return true;
}
