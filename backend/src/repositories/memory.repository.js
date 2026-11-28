
import pool from "../config/database.js";
import {
  analyzeMemoryAttribution,
  buildHistoricalPreferenceContent,
  buildMemoryContent,
  getPreferenceCategory,
  normalizeMemoryKey,
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
  const attribution = analyzeMemoryAttribution(content);
  const exactContent = options.exactContent === true;
  const normalizedKey = exactContent ? null : normalizeMemoryKey(content);

  if (attribution.ambiguous || !attribution.subject || (!exactContent && !normalizedKey)) {
    return null;
  }

  const expiresAt = options.expiresAt ?? null;
  const permanentOnly = options.permanentOnly ?? expiresAt === null;
  const params = [userId, memoryType];
  let expiryCondition = "expires_at IS NULL";
  let contentCondition = "";

  if (!permanentOnly) {
    params.push(expiresAt);
    expiryCondition = "expires_at > NOW() AND expires_at = $3";

    if (options.sourceMessageId) {
      params.push(options.sourceMessageId);
      expiryCondition = "expires_at > NOW() AND (expires_at = $3 OR source_message_id = $4)";
    }
  }

  if (exactContent) {
    params.push(content);
    contentCondition = `AND content = $${params.length}`;
  }

  const { rows } = await client.query(
    `SELECT id, content
     FROM memories
     WHERE user_id = $1
       AND memory_type = $2
       AND is_active = TRUE
       AND ${expiryCondition}
       ${contentCondition}
     ORDER BY updated_at DESC`,
    params
  );

  const matchesDuplicate = (memory) => {
    const candidateAttribution = analyzeMemoryAttribution(memory.content);

    return !candidateAttribution.ambiguous &&
      candidateAttribution.subject === attribution.subject &&
      (exactContent
        ? memory.content === content
        : normalizeMemoryKey(memory.content) === normalizedKey);
  };
  const duplicate = rows.find(matchesDuplicate);

  if (!duplicate) {
    return null;
  }

  const lockParams = [duplicate.id, userId, memoryType];
  let lockExpiryCondition = "expires_at IS NULL";
  let lockContentCondition = "";

  if (!permanentOnly) {
    lockParams.push(expiresAt);
    lockExpiryCondition = "expires_at > NOW() AND expires_at = $4";

    if (options.sourceMessageId) {
      lockParams.push(options.sourceMessageId);
      lockExpiryCondition = "expires_at > NOW() AND (expires_at = $4 OR source_message_id = $5)";
    }
  }

  if (exactContent) {
    lockParams.push(content);
    lockContentCondition = `AND content = $${lockParams.length}`;
  }

  const { rows: lockedRows } = await client.query(
    `SELECT *
     FROM memories
     WHERE id = $1
       AND user_id = $2
       AND memory_type = $3
       AND is_active = TRUE
       AND ${lockExpiryCondition}
       ${lockContentCondition}
     FOR UPDATE`,
    lockParams
  );
  const locked = lockedRows[0];

  return locked && matchesDuplicate(locked) ? locked : null;
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
         OR left(
           normalize(lower(normalize(content, NFKC)), NFKC),
           length(normalize(lower(normalize($4, NFKC)), NFKC))
         ) = normalize(lower(normalize($4, NFKC)), NFKC)
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

  const existing = await findDuplicateMemory(client, userId, "fact", content, {
    exactContent: !normalizeMemoryKey(attribution.text)
  });
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

  const sharedClient = options.client;
  const ownsTransaction = !sharedClient;
  const client = sharedClient ?? await pool.connect();
  const commit = () => ownsTransaction ? client.query("COMMIT") : Promise.resolve();
  const rollback = () => ownsTransaction ? client.query("ROLLBACK") : Promise.resolve();

  try {
    if (ownsTransaction) {
      await client.query("BEGIN");
    }

    if (!(await sourceMessageIsOwned(client, userId, options.sourceMessageId))) {
      await rollback();
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
      await commit();
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
      await rollback();
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

    await commit();
    return saved;
  } catch (error) {
    if (ownsTransaction) {
      try {
        await rollback();
      } catch {}

      throw new Error("Memory create transaction failed.", { cause: error });
    }

    throw error;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
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

  const sharedClient = options.client;
  const ownsTransaction = !sharedClient;
  const client = sharedClient ?? await pool.connect();
  const commit = () => ownsTransaction ? client.query("COMMIT") : Promise.resolve();
  const rollback = () => ownsTransaction ? client.query("ROLLBACK") : Promise.resolve();

  try {
    if (ownsTransaction) {
      await client.query("BEGIN");
    }

    if (!(await sourceMessageIsOwned(client, userId, options.sourceMessageId))) {
      await rollback();
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
      await rollback();
      return { status: "invalid_target" };
    }

    if (
      target.memory_type !== memoryType ||
      targetAttribution.ambiguous ||
      targetAttribution.subject !== attribution.subject ||
      target.expires_at !== null ||
      expiresAt !== null
    ) {
      await rollback();
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
      await commit();
      return duplicate
        ? { status: "superseded", memory: duplicate }
        : { status: "stale_target" };
    }

    if (duplicate?.id === target.id) {
      await rollback();
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
        await rollback();
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

    await commit();
    return { status: "superseded", memory: saved };
  } catch (error) {
    if (ownsTransaction) {
      try {
        await rollback();
      } catch {}

      throw new Error("Memory supersede transaction failed.", { cause: error });
    }

    throw error;
  } finally {
    if (ownsTransaction) {
      client.release();
    }
  }
}

export async function executeMemoryPlan(userId, plan, sourceMessageId) {
  const steps = Array.isArray(plan)
    ? plan.filter((step) => step && step.type !== "skip")
    : [];

  if (steps.length === 0) {
    return { savedMemories: [], supersededCount: 0 };
  }

  const client = await pool.connect();
  const savedMemories = [];
  let supersededCount = 0;

  try {
    await client.query("BEGIN");

    for (const step of steps) {
      if (step.type === "supersede") {
        const result = await supersedeMemory(
          userId,
          step.replacesId,
          step.memory.memoryType,
          step.memory.content,
          {
            confidence: step.memory.confidence,
            importance: step.memory.importance,
            expiresAt: step.memory.expiresAt,
            sourceMessageId,
            client
          }
        );

        if (result.status !== "superseded") {
          throw new Error(`Memory supersede failed: ${result.status}`);
        }

        savedMemories.push(result.memory);
        supersededCount++;
        continue;
      }

      if (step.type !== "add") {
        throw new Error(`Unsupported memory plan action: ${step.type}`);
      }

      const saved = await createMemory(
        userId,
        step.memory.memoryType,
        step.memory.content,
        {
          confidence: step.memory.confidence,
          importance: step.memory.importance,
          expiresAt: step.memory.expiresAt,
          sourceMessageId,
          client
        }
      );

      if (!saved) {
        throw new Error("Memory insert failed: invalid source message or memory details.");
      }

      savedMemories.push(saved);
    }

    await client.query("COMMIT");
    return { savedMemories, supersededCount };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Memory extraction rollback failed:", rollbackError.message);
    }

    throw new Error("Memory extraction plan transaction failed.", { cause: error });
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

    const normalizedContent = normalizeMemoryText(attribution.content);

    if (
      normalizedContent &&
      normalizeMemoryText(target.content) === normalizedContent
    ) {
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
