
import { z } from "zod";

export const memorySubjectSchema = z.string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}][\p{L}\p{M}\p{N}'’-]*(?: [\p{L}][\p{L}\p{M}\p{N}'’-]*)*$/u, "Invalid memory subject");

export const createMemorySchema = z.object({
  memoryType: z.enum([
    "fact",
    "preference",
    "commitment",
    "goal",
    "other"
  ]),
  content: z.string().trim().min(1).max(5000),
  subject: memorySubjectSchema.optional(),
  confidence: z.number().min(0).max(1).optional().default(1),
  importance: z.number().int().min(1).max(5).optional().default(3),
  sourceMessageId: z.uuid().nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional()
}).strict();

export const updateMemorySchema = z.object({
  content: z.string().trim().min(1).max(5000),
  subject: memorySubjectSchema.optional()
}).strict();

export const memoryParamsSchema = z.object({
  id: z.uuid()
});
