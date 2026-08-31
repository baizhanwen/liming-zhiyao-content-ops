import { getD1 } from "../db/runtime";
import { authorizedKnowledgePromptSource, retrieveAuthorizedKnowledge, type AuthorizedKnowledgeTask } from "./authorized-knowledge";
import { retrieveProjectContext, type MemorySource } from "./project-memory";
import { dedupeProjectGenerationSources, mapProjectContextSources } from "./generation-source-utils";
import type { ProjectGenerationSource } from "./project-generation-context";

export function mapGenerationContextSources(sources: MemorySource[], organizationId: string, projectId: string) {
  return mapProjectContextSources(sources, organizationId, projectId) as ProjectGenerationSource[];
}

export async function retrieveDefaultProjectGenerationSources(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  purpose: string;
  query: string;
  methodologyTask: AuthorizedKnowledgeTask;
  maxCharacters?: number;
}) {
  const [projectContext, methodology] = await Promise.all([
    retrieveProjectContext({ organizationId: input.organizationId, projectId: input.projectId, userId: input.userId, purpose: input.purpose, query: input.query, maxCharacters: input.maxCharacters }),
    retrieveAuthorizedKnowledge(getD1(), input.query, {
      task: input.methodologyTask,
      limit: 8,
      allowedAtomTypes: ["method", "principle", "anti-pattern"],
      minimumConfidence: "medium",
    }),
  ]);
  // Raw insights, cases and low-confidence atoms must not silently become
  // instructions. Cases belong in an explicitly selected reference layer;
  // only curated method/principle/anti-pattern atoms may support a method plan.
  const eligibleMethodology = methodology
    .filter((atom) => atom.confidence !== "low" && ["method", "principle", "anti-pattern"].includes(atom.atom_type));
  const methodSources: ProjectGenerationSource[] = eligibleMethodology.map((atom) => ({
    sourceType: "method_knowledge",
    sourceId: atom.id,
    title: "授权方法：" + atom.knowledge,
    text: authorizedKnowledgePromptSource(atom),
    systemMethodology: true,
    score: atom.score,
    matchedTerms: atom.matchedTerms,
    confidence: atom.confidence,
  }));
  const projectSources = mapGenerationContextSources(projectContext.sources, input.organizationId, input.projectId);
  const sources = dedupeProjectGenerationSources([...projectSources, ...methodSources]);
  return { ...projectContext, projectSources, methodologySources: methodSources, sources };
}
