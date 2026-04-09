import { z } from 'zod';

export const KnowledgeJanitorInputSchema = z.object({
  scope: z.enum(['full', 'audit', 'ingest']).default('full')
    .describe('full: scan+cleanup+ingest | audit: scan+cleanup only | ingest: scan+ingest only'),
  fileFilter: z.string().optional()
    .describe('Optional glob or substring to restrict which files are processed'),
});

export type KnowledgeJanitorInput = z.infer<typeof KnowledgeJanitorInputSchema>;
