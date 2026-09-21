// Demo file for the semantic-lint check. Do not merge. Not part of the tool.

declare const db: { query(sql: string, params: unknown[]): Promise<unknown[]> };

export async function totals(ids: string[]) {
  const out: unknown[][] = [];
  for (const id of ids) {
    out.push(await db.query("SELECT * FROM line_items WHERE order_id = $1", [id]));
  }
  return out;
}
