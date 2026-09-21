// Demo file for the semantic-lint check. Do not merge. Not part of the tool.

declare const db: { query(sql: string, params: unknown[]): Promise<unknown[]> };

export async function syncOrder(id: string) {
  try {
    await db.query("UPDATE orders SET synced = true WHERE id = $1", [id]);
  } catch (e) {
    console.error("order sync failed", e);
    throw e;
  }
}
