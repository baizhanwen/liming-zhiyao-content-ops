import { canAccessOrganizationVideoLibrary, getD1, getOrganizationAccess, getProjectAccess } from "../db/runtime";

export type LibrarySource = { entry_id: string; video_id: string; source_project_id: string };
import { upsertProjectVideoReference as upsertReference, type ProjectVideoReferenceAction } from "./video-reference-state";

export type { ProjectVideoReferenceAction };

type VideoLibraryDatabase = ReturnType<typeof getD1>;

export async function upsertProjectVideoReference(input: { db?: VideoLibraryDatabase; organizationId: string; projectId: string; libraryEntryId: string; purpose: "analysis" | "benchmark"; userId: string; now: string }) {
  return upsertReference(input.db ?? getD1(), input);
}

export async function getAccessibleLibrarySource(authSubject: string, organizationId: string, entryId: string, projectId?: string) {
  const db = getD1();
  const source = await db.prepare(`
    SELECT library.id AS entry_id, v.id AS video_id, v.project_id AS source_project_id
    FROM video_library_entries library
    INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
    WHERE library.id = ? AND library.organization_id = ? AND v.deleted_at IS NULL
  `).bind(entryId, organizationId).first<LibrarySource>();
  if (!source) return null;
  const organization = await getOrganizationAccess(authSubject, organizationId);
  if (organization && await canAccessOrganizationVideoLibrary(organization)) return source;
  if (!projectId) return null;
  const project = await getProjectAccess(authSubject, organizationId, projectId);
  if (!project) return null;
  const reference = await db.prepare(`
    SELECT 1 AS allowed FROM project_video_references
    WHERE organization_id = ? AND project_id = ? AND library_entry_id = ? AND status = 'active'
    LIMIT 1
  `).bind(organizationId, projectId, entryId).first<{ allowed: number }>();
  return reference?.allowed ? source : null;
}
