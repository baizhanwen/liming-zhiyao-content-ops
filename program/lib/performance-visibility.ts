/** Reuse the established explicit private-status exclusions in both reports.
 * Empty or other supplier labels remain unverified; do not guess their meaning.
 */
export function publicPlatformWorkSql(alias: "w" | "pw") {
  return `COALESCE(${alias}.review_status,'') NOT LIKE '%自见%'
    AND COALESCE(${alias}.review_status,'') NOT LIKE '%仅自己%'
    AND COALESCE(${alias}.review_status,'') NOT LIKE '%私密%'`;
}
