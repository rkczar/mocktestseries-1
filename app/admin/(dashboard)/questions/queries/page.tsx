// "Queries" and "Reports" are the same feature (student-flagged question
// issues) — this tab used to be an unbuilt stub sitting alongside the real
// implementation in ../reports/page.tsx. Re-exporting instead of building a
// second, parallel triage UI against the same ReportedQuestion table.
export { default, metadata } from "../reports/page";
