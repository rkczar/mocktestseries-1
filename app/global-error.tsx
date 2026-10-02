"use client";

/**
 * Last-resort boundary for a failure in the root layout itself. It replaces
 * the whole document, so it carries its own minimal, theme-neutral styles.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", background: "#0b1020", color: "#e5e7eb", padding: 16 }}>
        <title>Something went wrong — Mock Test Series.in</title>
        <main style={{ maxWidth: 480, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 .75rem" }}>Something went wrong</h1>
          <p style={{ color: "#9ca3af", lineHeight: 1.6 }}>Please try again. Your saved answers and progress are safe.</p>
          <p style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button onClick={() => retry()} style={{ padding: "8px 16px", borderRadius: 8, border: 0, background: "#6366f1", color: "#fff", cursor: "pointer" }}>
              Try again
            </button>
            {/* A full document load on purpose: the root layout itself failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #374151", color: "#e5e7eb", textDecoration: "none" }}>
              Homepage
            </a>
          </p>
          {error.digest ? <p style={{ color: "#6b7280", fontSize: 12 }}>Reference: {error.digest}</p> : null}
        </main>
      </body>
    </html>
  );
}
