
import {
  createMemory,
  getMemoryById,
  getUserMemories,
  updateMemory,
  deactivateMemory
} from "../repositories/memory.repository.js";

import {
  analyzeMemoryAttribution,
  subjectsMatch,
  validateMemoryAttribution
} from "../utils/memory-format.js";

const ALLOWED_TYPES = [
  "fact",
  "preference",
  "commitment",
  "goal",
  "other"
];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// Create memory
export async function createMemoryController(req, res) {
  try {
    const {
      memoryType,
      subject,
      content,
      confidence,
      importance,
      sourceMessageId,
      expiresAt
    } = req.body;

    const normalizedConfidence =
      confidence === undefined ? 1 : Number(confidence);

    const normalizedImportance =
      importance === undefined ? 3 : Number(importance);

    if (
      typeof content !== "string" ||
      !content.trim() ||
      (subject !== undefined &&
        (typeof subject !== "string" || !subject.trim())) ||
      !ALLOWED_TYPES.includes(memoryType) ||
      !Number.isFinite(normalizedConfidence) ||
      normalizedConfidence < 0 ||
      normalizedConfidence > 1 ||
      !Number.isInteger(normalizedImportance) ||
      normalizedImportance < 1 ||
      normalizedImportance > 5 ||
      (sourceMessageId != null &&
        (typeof sourceMessageId !== "string" ||
          !UUID_REGEX.test(sourceMessageId))) ||
      (expiresAt != null &&
        (typeof expiresAt !== "string" ||
          Number.isNaN(Date.parse(expiresAt))))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid memory details"
      });
    }

    const attribution = validateMemoryAttribution(content, subject, {
      requireSubject: false
    });

    if (!attribution.valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid memory subject or content"
      });
    }

    const memory = await createMemory(
      req.user.id,
      memoryType,
      attribution.content,
      {
        confidence: normalizedConfidence,
        importance: normalizedImportance,
        sourceMessageId,
        expiresAt
      }
    );

    if (!memory) {
      return res.status(400).json({
        success: false,
        message: "Invalid source message or memory details"
      });
    }

    return res.status(201).json({
      success: true,
      memory
    });

  } catch (error) {
    console.error("Create memory error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to create memory"
    });
  }
}


// Get user's active memories
export async function getMemoriesController(req, res) {
  try {
    const memories = await getUserMemories(req.user.id);

    return res.status(200).json({
      success: true,
      memories
    });

  } catch (error) {
    console.error("Get memories error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch memories"
    });
  }
}


// Update memory content
export async function updateMemoryController(req, res) {
  try {
    const { content, subject } = req.body;
    const { id } = req.params;

    if (
      !UUID_REGEX.test(id) ||
      typeof content !== "string" ||
      !content.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid memory ID and content are required"
      });
    }

    const existing = await getMemoryById(req.user.id, id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Memory not found"
      });
    }

    const existingAttribution = analyzeMemoryAttribution(existing.content);

    if (existingAttribution.ambiguous) {
      return res.status(400).json({
        success: false,
        message: "Memory subject is ambiguous"
      });
    }

    if (
      subject !== undefined &&
      !subjectsMatch(subject, existingAttribution.subject)
    ) {
      return res.status(400).json({
        success: false,
        message: "Memory subject cannot be changed"
      });
    }

    const attribution = validateMemoryAttribution(
      content,
      existingAttribution.subject,
      { requireSubject: true }
    );

    if (!attribution.valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid memory subject or content"
      });
    }

    const result = await updateMemory(
      req.user.id,
      id,
      attribution.content
    );

    if (result.status === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Memory not found"
      });
    }

    if (result.status === "duplicate") {
      return res.status(409).json({
        success: false,
        message: "A matching active memory already exists",
        memory: result.memory
      });
    }

    if (result.status !== "updated") {
      return res.status(400).json({
        success: false,
        message: "Invalid memory subject or content"
      });
    }

    return res.status(200).json({
      success: true,
      memory: result.memory
    });

  } catch (error) {
    console.error("Update memory error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update memory"
    });
  }
}


// Deactivate memory
export async function deleteMemoryController(req, res) {
  try {
    const { id } = req.params;

    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({
        success: false,
        message: "Valid memory ID is required"
      });
    }

    const deleted = await deactivateMemory(
      req.user.id,
      id
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Memory not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Memory deactivated successfully"
    });

  } catch (error) {
    console.error("Deactivate memory error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to deactivate memory"
    });
  }
}
