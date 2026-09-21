// Demo file for the semantic-lint check. Do not merge. Not part of the tool.

declare const db: { query(sql: string, params: unknown[]): Promise<unknown[]> };

export async function totals(ids: string[]) {
  const rows = (await db.query("SELECT * FROM line_items WHERE order_id = ANY($1)", [ids])) as { order_id: string }[];
  return ids.map((id) => rows.filter((r) => r.order_id === id));
}
