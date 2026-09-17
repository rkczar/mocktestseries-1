import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DiagramNode, DiagramEdge } from "@/lib/diagram-graph";
import { resolveDisplayStatus } from "@/lib/diagram-status";
import styles from "./graph-view.module.css";

export type DrawerSelection = { kind: "node"; node: DiagramNode } | { kind: "edge"; edge: DiagramEdge };

function ConnectionRow({
  nodeId,
  source,
  label,
  broken,
  pageNameByRoute,
}: {
  nodeId: string;
  source: string;
  label?: string;
  broken: boolean;
  pageNameByRoute: Map<string, string>;
}) {
  return (
    <div className={styles.connectionRow} data-broken={broken || undefined}>
      <span className={styles.connectionRoute}>{pageNameByRoute.get(nodeId) ?? nodeId}</span>
      <span className={styles.connectionSource}>{label ?? source}</span>
    </div>
  );
}

export function DetailsDrawer({
  selection,
  pageNameByRoute,
  onClose,
}: {
  selection: DrawerSelection;
  pageNameByRoute: Map<string, string>;
  onClose: () => void;
}) {
  return (
    <aside className={styles.drawer}>
      <div className={styles.drawerHeader}>
        <h3 className={styles.drawerTitle}>{selection.kind === "node" ? "Page details" : "Connection details"}</h3>
        <button type="button" onClick={onClose} className={styles.drawerClose} aria-label="Close details">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {selection.kind === "node" ? (
        <div className={styles.drawerBody}>
          <div>
            <p className={styles.drawerFieldLabel}>Page</p>
            <p className={styles.drawerFieldValue}>{selection.node.pageName}</p>
          </div>
          <div>
            <p className={styles.drawerFieldLabel}>Route</p>
            <p className={styles.drawerFieldValueMono}>{selection.node.route}</p>
          </div>
          <div className={styles.drawerRow}>
            <div>
              <p className={styles.drawerFieldLabel}>User Type</p>
              <p className={styles.drawerFieldValue}>{selection.node.userType}</p>
            </div>
            <div>
              <p className={styles.drawerFieldLabel}>Status</p>
              <Badge variant={resolveDisplayStatus(selection.node).variant}>{resolveDisplayStatus(selection.node).label}</Badge>
            </div>
          </div>
          {selection.node.deprecated ? (
            <div className={styles.warningBox}>⚠ Deprecated — kept in the codebase for old links/bookmarks, no longer part of the current product surface.</div>
          ) : selection.node.missing ? (
            <div className={styles.warningBox}>⚠ Missing — registered in the route registry but no matching page.tsx exists on disk.</div>
          ) : selection.node.isolated ? (
            <div className={styles.warningBox}>⚠ Isolated page — no incoming or outgoing connections detected.</div>
          ) : selection.node.noIncoming ? (
            <div className={styles.warningBox}>⚠ Nothing links into this page yet — it&apos;s only reachable by typing the URL directly.</div>
          ) : null}
          {selection.node.autoDiscovered ? (
            <div className={styles.warningBox}>
              🆕 Auto-discovered — this page exists in the codebase but hasn&apos;t been added to the route registry yet.
            </div>
          ) : null}

          <div>
            <p className={styles.drawerSectionLabel}>
              Incoming connections ({selection.node.incoming.length})
            </p>
            {selection.node.incoming.length ? (
              <div className={styles.connectionList}>
                {selection.node.incoming.map((c, i) => (
                  <ConnectionRow key={`${c.nodeId}-${i}`} nodeId={c.nodeId} source={c.source} label={c.label} broken={c.broken} pageNameByRoute={pageNameByRoute} />
                ))}
              </div>
            ) : (
              <p className={styles.drawerEmpty}>Nothing navigates into this page.</p>
            )}
          </div>

          <div>
            <p className={styles.drawerSectionLabel}>
              Outgoing connections ({selection.node.outgoing.length})
            </p>
            {selection.node.outgoing.length ? (
              <div className={styles.connectionList}>
                {selection.node.outgoing.map((c, i) => (
                  <ConnectionRow key={`${c.nodeId}-${i}`} nodeId={c.nodeId} source={c.source} label={c.label} broken={c.broken} pageNameByRoute={pageNameByRoute} />
                ))}
              </div>
            ) : (
              <p className={styles.drawerEmpty}>This page has no outgoing navigation.</p>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.drawerBody}>
          <div>
            <p className={styles.drawerFieldLabel}>From</p>
            <p className={styles.drawerFieldValue}>{pageNameByRoute.get(selection.edge.from) ?? selection.edge.from}</p>
            <p className={styles.drawerFieldValueMono}>{selection.edge.from}</p>
          </div>
          <div>
            <p className={styles.drawerFieldLabel}>To</p>
            <p className={styles.drawerFieldValue}>{pageNameByRoute.get(selection.edge.to) ?? selection.edge.to}</p>
            <p className={styles.drawerFieldValueMono}>{selection.edge.to}</p>
          </div>
          <div className={styles.drawerRow}>
            <div>
              <p className={styles.drawerFieldLabel}>Source</p>
              <p className={styles.drawerFieldValue}>{selection.edge.label ?? selection.edge.source}</p>
            </div>
            <div>
              <p className={styles.drawerFieldLabel}>Type</p>
              <p className={styles.drawerFieldValue}>{selection.edge.source === "internal" ? "Internal Navigation" : "Cross-page Navigation"}</p>
            </div>
          </div>
          <div>
            <p className={styles.drawerFieldLabel}>Status</p>
            {selection.edge.broken ? (
              <div className={styles.warningBox}>⚠ Broken connection — destination route not found in the registry.</div>
            ) : (
              <Badge variant="success">Connected</Badge>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
