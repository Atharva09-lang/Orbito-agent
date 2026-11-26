export async function readAuthUserVerificationRows(client, userIds) {
  const result = await client.query(
    `SELECT id, name, email, "emailVerified", "createdAt", "updatedAt"
     FROM neon_auth."user"
     WHERE id = ANY($1::uuid[])
     ORDER BY "createdAt", id`,
    [userIds]
  );

  return result.rows;
}
