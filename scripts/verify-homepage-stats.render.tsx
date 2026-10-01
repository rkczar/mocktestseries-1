/**
 * Child process for scripts/verify-homepage-stats.ts: renders the public
 * StatisticsSection to static HTML for each scenario read from stdin. Runs
 * without the react-server condition so react-dom/server is available.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StatisticsSection } from "@/components/homepage/sections";

const scenarios = JSON.parse(readFileSync(0, "utf8")) as Record<string, { content: Record<string, unknown>; statValues: never[] }>;
const out: Record<string, string> = {};
for (const [name, { content, statValues }] of Object.entries(scenarios)) {
  out[name] = renderToStaticMarkup(<StatisticsSection content={content} resolved={{ statValues }} />);
}
process.stdout.write(JSON.stringify(out));
