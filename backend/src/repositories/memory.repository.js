
import pool from "../config/database.js";
import {
  analyzeMemoryAttribution,
  buildHistoricalPreferenceContent,
  buildMemoryContent,
  getPreferenceCategory,
  normalizeMemoryText,
  validateMemoryAttribution
} from "../utils/memory-format.js";

async function insertMemory(client, userId, memoryType, content, options = {}) {
  const {
    confidence = 1.0,
    importance = 3,
    sourceMessageId = null,
    expiresAt = null
  } = options;

  const query = `
    INSERT INTO memories (
      user_id,
      memory_type,
      content,
      confidence,
      importance,
      source_message_id,
      expires_at
    )
    SELECT $1, $2, $3, $4, $5, $6, $7
    WHERE
      $6::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $6::uuid AND c.user_id = $1
      )
    RETURNING *
  `;

  const { rows } = await client.query(query, [
    userId,
    memoryType,
    content,
    confidence,
    importance,
    sourceMessageId,
    expiresAt
  ]);

  return rows[0] || null;
}

function normalizeMemoryKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function lockMemoryScope(client, userId, subject, memoryType) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`memory:${userId}:${subject}:${memoryType}`]
  );
}

async function sourceMessageIsOwned(client, userId, sourceMessageId) {
  if (!sourceMessageId) {
    return true;
  }

  const { rows } = await client.query(
    `SELECT 1
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = $2::uuid AND c.user_id = $1`,
    [userId, sourceMessageId]
  );

  return rows.length > 0;
}

async function findDuplicateMemory(client, userId, memoryType, content, options = {}) {
  const expiresAt = options.expiresAt ?? null;
  const permanentOnly = options.permanentOnly ?? expiresAt === null;
  const params = [userId, memoryType, normalizeMemoryKey(content)];
  let expiryCondition = "expires_at IS NULL";

  if (!permanentOnly) {
    params.push(expiresAt);
    expiryCondition = "expires_at > NOW() AND expires_at = $4";

    if (options.sourceMessageId) {
      params.push(options.sourceMessageId);
      expiryCondition = "expires_at > NOW() AND (expires_at = $4 OR source_message_id = $5)";
    }
  }

  const { rows } = await client.query(
    `SELECT *
     FROM memories
     WHERE user_id = $1
       AND memory_type = $2
       AND is_active = TRUE
       AND ${expiryCondition}
       AND trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) = $3
     ORDER BY updated_at DESC
     LIMIT 1
     FOR UPDATE`,
    params
  );

  return rows[0] || null;
}

async function findActiveCategoryPreferences(client, userId, subject, memoryType, category) {
  if (memoryType !== "preference" || !category) {
    return [];
  }

  const categoryPatterns = {
    backend: "\\mbackend\\M",
    dsa: "\\m(dsa|data structures?)\\M",
    frontend: "\\mfrontend\\M"
  };
  const { rows } = await client.query(
    `SELECT id, memory_type, content, confidence, importance, source_message_id, expires_at
     FROM memories
     WHERE user_id = $1
       AND memory_type = $2
       AND is_active = TRUE
       AND expires_at IS NULL
       AND (
         ($3 = 'user' AND content NOT ILIKE '[about:%')
         OR lower(left(content, length($4))) = lower($4)
       )
       AND content ~* $5
     ORDER BY updated_at, id
     FOR UPDATE`,
    [userId, memoryType, subject, `[about: ${subject}] `, categoryPatterns[category]]
  );

  return rows.filter((memory) => {
    const attribution = analyzeMemoryAttribution(memory.content);

    return !attribution.ambiguous &&
      attribution.subject === subject &&
      getPreferenceCategory(memory.content) === category;
  });
}

async function deactivateMemoryRow(client, userId, memoryId) {
  const { rows } = await client.query(
    `UPDATE memories
     SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_active = TRUE
     RETURNING id`,
    [memoryId, userId]
  );

  if (rows.length === 0) {
    throw new Error("Memory deactivation failed.");
  }
}

async function ensureHistoricalPreference(client, userId, target) {
  const attribution = analyzeMemoryAttribution(target.content);
  const content = buildMemoryContent(
    attribution.subject,
    buildHistoricalPreferenceContent(attribution.text)
  );

  await lockMemoryScope(client, userId, attribution.subject, "fact");

  const existing = await findDuplicateMemory(client, userId, "fact", content);
  if (existing) {
    return existing;
  }

  const historical = await insertMemory(client, userId, "fact", content, {
    confidence: target.confidence ?? 1.0,
    importance: target.importance ?? 3,
    sourceMessageId: target.source_message_id ?? null,
    expiresAt: null
  });

  if (!historical) {
    throw new Error("Historical preference insert failed.");
  }

  return historical;
}

async function reconcileCategoryPreferences(
  client,
  userId,
  subject,
  memoryType,
  category,
  winnerId,
  targets = []
) {
  if (memoryType !== "preference") {
    return;
  }

  const activeCategory = category
    ? await findActiveCategoryPreferences(client, userId, subject, memoryType, category)
    : [];
  const toDeactivate = new Map();

  for (const memory of [...targets, ...activeCategory]) {
    if (memory.id !== winnerId) {
      toDeactivate.set(memory.id, memory);
    }
  }

  for (const memory of toDeactivate.values()) {
    await ensureHistoricalPreference(client, userId, memory);
  }

  for (const memory of toDeactivate.values()) {
    await deactivateMemoryRow(client, userId, memory.id);
  }
}

export async function createMemory(
  userId,
  memoryType,
  content,
  options = {}
) {
  const attribution = validateMemoryAttribution(content, undefined, {
    requireSubject: false
  });

  if (!attribution.valid) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (!(await sourceMessageIsOwned(client, userId, options.sourceMessageId))) {
      await client.query("ROLLBACK");
      return null;
    }

    await lockMemoryScope(client, userId, attribution.subject, memoryType);

    const duplicate = await findDuplicateMemory(
      client,
      userId,
      memoryType,
      attribution.content,
      {
        expiresAt: options.expiresAt ?? null,
        sourceMessageId: options.sourceMessageId
      }
    );

    if (duplicate) {
      await client.query("COMMIT");
      return duplicate;
    }

    const saved = await insertMemory(
      client,
      userId,
      memoryType,
      attribution.content,
      options
    );

    if (!saved) {
      await client.query("ROLLBACK");
      return null;
    }

    const category = (options.expiresAt ?? null) === null
      ? getPreferenceCategory(attribution.content)
      : null;
    await reconcileCategoryPreferences(
      client,
      userId,
      attribution.subject,
      memoryType,
      category,
      saved.id
    );

    await client.query("COMMIT");
    return saved;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw new Error("Memory create transaction failed.", { cause: error });
  } finally {
    client.release();
  }
}

export async function supersedeMemory(
  userId,
  replacesId,
  memoryType,
  content,
  options = {}
) {
  const attribution = validateMemoryAttribution(content, undefined, {
    requireSubject: false
  });

  if (!attribution.valid) {
    return { status: "invalid_memory" };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (!(await sourceMessageIsOwned(client, userId, options.sourceMessageId))) {
      await client.query("ROLLBACK");
      return { status: "invalid_source" };
    }

    await lockMemoryScope(client, userId, attribution.subject, memoryType);

    const targetResult = await client.query(
      `SELECT id, memory_type, content, confidence, importance, source_message_id, expires_at, is_active
       FROM memories
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [replacesId, userId]
    );

    const target = targetResult.rows[0];
    const expiresAt = options.expiresAt ?? null;
    const targetAttribution = target
      ? analyzeMemoryAttribution(target.content)
      : null;

    if (!target) {
      await client.query("ROLLBACK");
      return { status: "invalid_target" };
    }

    if (
      target.memory_type !== memoryType ||
      targetAttribution.ambiguous ||
      targetAttribution.subject !== attribution.subject ||
      target.expires_at !== null ||
      expiresAt !== null
    ) {
      await client.query("ROLLBACK");
      return { status: "incompatible_target" };
    }

    const duplicate = await findDuplicateMemory(
      client,
      userId,
      memoryType,
      attribution.content,
      { permanentOnly: true }
    );

    if (!target.is_active) {
      await client.query("COMMIT");
      return duplicate
        ? { status: "superseded", memory: duplicate }
        : { status: "stale_target" };
    }

    if (duplicate?.id === target.id) {
      await client.query("ROLLBACK");
      return { status: "duplicate_target" };
    }

    const category = getPreferenceCategory(attribution.content);
    let saved = duplicate;

    if (!saved) {
      saved = await insertMemory(
        client,
        userId,
        memoryType,
        attribution.content,
        options
      );

      if (!saved) {
        await client.query("ROLLBACK");
        return { status: "invalid_source" };
      }
    }

    await reconcileCategoryPreferences(
      client,
      userId,
      attribution.subject,
      memoryType,
      category,
      saved.id,
      [target]
    );

    await client.query("COMMIT");
    return { status: "superseded", memory: saved };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw new Error("Memory supersede transaction failed.", { cause: error });
  } finally {
    client.release();
  }
}

// Get active memories
export async function getUserMemories(userId, limit = 50) {
  const query = `
    SELECT *
    FROM memories
    WHERE user_id = $1
      AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY importance DESC, updated_at DESC
    LIMIT $2
  `;

  const { rows } = await pool.query(query, [userId, limit]);

  return rows;
}

export async function getMemoryById(userId, memoryId) {
  const { rows } = await pool.query(
    "SELECT * FROM memories WHERE user_id = $1 AND id = $2",
    [userId, memoryId]
  );

  return rows[0] || null;
}

// Update memory content
export async function updateMemory(userId, memoryId, content) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const initialResult = await client.query(
      `SELECT *
       FROM memories
       WHERE user_id = $1 AND id = $2`,
      [userId, memoryId]
    );
    const initial = initialResult.rows[0];

    if (!initial) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }

    const initialAttribution = analyzeMemoryAttribution(initial.content);

    if (initialAttribution.ambiguous) {
      await client.query("ROLLBACK");
      return { status: "invalid_memory" };
    }

    await lockMemoryScope(client, userId, initialAttribution.subject, initial.memory_type);

    const targetResult = await client.query(
      `SELECT *
       FROM memories
       WHERE user_id = $1 AND id = $2
       FOR UPDATE`,
      [userId, memoryId]
    );
    const target = targetResult.rows[0];

    if (!target || !target.is_active) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }

    const targetAttribution = analyzeMemoryAttribution(target.content);

    if (
      targetAttribution.ambiguous ||
      targetAttribution.subject !== initialAttribution.subject ||
      target.memory_type !== initial.memory_type
    ) {
      await client.query("ROLLBACK");
      return { status: "invalid_memory" };
    }

    const attribution = validateMemoryAttribution(content, targetAttribution.subject, {
      requireSubject: true
    });

    if (!attribution.valid) {
      await client.query("ROLLBACK");
      return { status: "invalid_memory" };
    }

    if (normalizeMemoryText(target.content) === normalizeMemoryText(attribution.content)) {
      await client.query("COMMIT");
      return { status: "updated", memory: target };
    }

    const duplicate = await findDuplicateMemory(client, userId, target.memory_type, attribution.content, {
      expiresAt: target.expires_at ?? null
    });

    if (duplicate && duplicate.id !== target.id) {
      await client.query("ROLLBACK");
      return { status: "duplicate", memory: duplicate };
    }

    const category = (target.expires_at ?? null) === null
      ? getPreferenceCategory(attribution.content)
      : null;

    if (target.memory_type === "preference") {
      await ensureHistoricalPreference(client, userId, target);
    }

    await reconcileCategoryPreferences(
      client,
      userId,
      targetAttribution.subject,
      target.memory_type,
      category,
      target.id,
      [target]
    );

    const { rows } = await client.query(
      `UPDATE memories
       SET content = $3, updated_at = NOW()
       WHERE user_id = $1 AND id = $2
       RETURNING *`,
      [userId, memoryId, attribution.content]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }

    await client.query("COMMIT");
    return { status: "updated", memory: rows[0] };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw new Error("Memory update transaction failed.", { cause: error });
  } finally {
    client.release();
  }
}

// Deactivate a memory
export async function deactivateMemory(userId, memoryId) {
  const query = `
    UPDATE memories
    SET is_active = FALSE, updated_at = NOW()
    WHERE user_id = $1 AND id = $2
    RETURNING id
  `;

  const { rows } = await pool.query(query, [userId, memoryId]);

  return rows.length > 0;
}


export async function getRelevantMemories(userId, keywords = [], limit = 30) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid result limit");
  }

  const query = `
    SELECT
      *,
      (
        SELECT COUNT(*)
        FROM unnest($2::text[]) AS k(word)
        WHERE (
          ' ' || regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g') || ' '
        ) LIKE '% ' || k.word || ' %'
      )::int AS match_count
    FROM memories
    WHERE user_id = $1
      AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY
      match_count DESC,
      importance DESC,
      confidence DESC,
      updated_at DESC
    LIMIT $3
  `;

  const { rows } = await pool.query(query, [userId, keywords, limit]);

  return rows;
}
