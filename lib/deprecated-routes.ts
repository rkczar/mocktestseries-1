/**
 * Routes intentionally kept in the codebase (so old links/bookmarks don't
 * 404) but no longer part of the current product surface. Add a route here
 * once it's confirmed retired — the Website Diagram then labels it
 * "Deprecated" instead of a misleading "Working" or "Broken".
 *
 * Test architecture consolidation: Mock Test is the one admin-created test.
 * Grand / Custom / Random / Live Test and the generic Test Builder are
 * retired; each route below is a permanent redirect into the Mock Test
 * workflow (admin) or Test Series (student). Their Prisma models/tables stay
 * for legacy attempt/product compatibility — nothing is dropped.
 */
export const DEPRECATED_ROUTES: string[] = [
  "/admin/tests/builder",
  "/admin/tests/grand",
  "/admin/tests/grand/[id]",
  "/admin/tests/custom",
  "/admin/tests/random",
  "/admin/tests/live",
  "/admin/tests/live/[id]",
  "/student/live-tests",
];
