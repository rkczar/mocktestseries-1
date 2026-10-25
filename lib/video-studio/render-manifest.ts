/**
 * Where the render container serves the bundled fonts from (an origin that
 * exists only inside the container's request interception — see
 * ops/video-worker/render.mjs). Scene documents for rendering use these.
 */
export const RENDER_FONT_ORIGIN = "http://render.local";
export const RENDER_FONT_BASE = `${RENDER_FONT_ORIGIN}/fonts/`;
