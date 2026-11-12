"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  forcePublishQuestionAction,
  publishFromListAction,
} from "../../actions";

/**
 * NORMAL PUBLISH (every existing rule applies) and FORCE TO PUBLISH (Master Admin override: publishes the stored content
 * past every normal validation blocker after a confirmation and a reason). A question the official key withdrew can
 * instead be added to its paper as WITHDRAWN. The server re-checks the role; this card only collects the decision.
 */
export function ForcePublishCard(props: {
  questionId: string;
  label: string;
  normalBlocker: string | null;
  bypassed: string[];
  canForce: boolean;
  withdrawnInKey: boolean;
  /** Already in the Question Bank: the actions are closed; only the stored state (and any result message) is shown. */
  stored?: { code: string; status: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const reasonOk = reason.trim().length >= 5;

  const force = (kind: "PUBLISH" | "WITHDRAWN") =>
    start(async () => {
      setMessage(null);
      const r = await forcePublishQuestionAction(props.questionId, {
        kind,
        reason,
        confirmed,
      });
      if (r.ok) {
        setMessage({
          ok: true,
          text: `${r.data.code}: ${r.data.status === "PUBLISHED" ? "PUBLISHED" : "added to the paper as WITHDRAWN"}${r.data.alreadyDone ? " (it already was)" : ""}. ${r.data.bypassed.length} blocker(s) bypassed and recorded in the audit trail.`,
        });
        router.refresh();
      } else setMessage({ ok: false, text: r.error });
    });
  const normal = () =>
    start(async () => {
      setMessage(null);
      const r = await publishFromListAction(props.questionId);
      setMessage(
        r.ok
          ? {
              ok: true,
              text: "Normal publish requested: it is imported and published by the importer worker.",
            }
          : { ok: false, text: r.error },
      );
      if (r.ok) router.refresh();
    });

  return (
    <Card data-testid="publish-actions">
      <CardHeader>
        <CardTitle>Publish {props.label}</CardTitle>
        <CardDescription>
          Two separate actions. Normal Publish follows every validation rule.
          Force to Publish is a Master Admin override.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {props.stored ? (
          <p data-testid="publish-stored">
            In the Question Bank as <strong>{props.stored.code}</strong> —{" "}
            {props.stored.status}.
          </p>
        ) : (
          <>
            <section
              className="flex flex-col gap-2"
              data-testid="normal-publish"
            >
              <h3 className="font-semibold">NORMAL PUBLISH</h3>
              <p className="text-[var(--color-muted-foreground)]">
                {props.normalBlocker
                  ? `Not possible now: ${props.normalBlocker}`
                  : "Existing validation rules apply."}
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !!props.normalBlocker}
                  onClick={normal}
                  data-testid="normal-publish-button"
                >
                  NORMAL PUBLISH
                </Button>
              </div>
            </section>

            <section
              className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3"
              data-testid="force-publish"
            >
              <h3 className="font-semibold text-[var(--color-error)]">
                FORCE TO PUBLISH — Master Admin override
              </h3>
              {props.canForce ? (
                <>
                  <p>
                    Publishes the question <strong>exactly as stored</strong>{" "}
                    (English, Hindi, options, answer, explanation, images) and
                    bypasses every normal question-validation blocker. Nothing
                    is rewritten; correct the content afterwards if needed.
                  </p>
                  {props.bypassed.length ? (
                    <div>
                      <p className="font-medium">
                        Blockers that will be bypassed and recorded (
                        {props.bypassed.length}):
                      </p>
                      <ul
                        className="list-disc pl-5 text-xs"
                        data-testid="force-bypassed"
                      >
                        {props.bypassed.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      No normal blocker is open right now.
                    </p>
                  )}
                  <Label htmlFor="force-reason">
                    Reason (kept in the audit trail)
                  </Label>
                  <Textarea
                    id="force-reason"
                    rows={2}
                    maxLength={1000}
                    value={reason}
                    onChange={(ev) => setReason(ev.target.value)}
                    data-testid="force-reason"
                  />
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(ev) => setConfirmed(ev.target.checked)}
                      data-testid="force-confirm"
                    />
                    <span>
                      I confirm: publish this question now despite the
                      validation errors listed above.
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending || !confirmed || !reasonOk}
                      onClick={() => force("PUBLISH")}
                      data-testid="force-publish-button"
                    >
                      FORCE TO PUBLISH
                    </Button>
                    {props.withdrawnInKey ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || !confirmed || !reasonOk}
                        onClick={() => force("WITHDRAWN")}
                        data-testid="add-withdrawn-button"
                      >
                        ADD TO PAPER AS WITHDRAWN
                      </Button>
                    ) : null}
                  </div>
                  {!reasonOk || !confirmed ? (
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Write a reason (at least 5 characters) and tick the
                      confirmation.
                    </p>
                  ) : null}
                </>
              ) : (
                <p
                  className="text-xs text-[var(--color-muted-foreground)]"
                  data-testid="force-readonly"
                >
                  Only a Master Admin can use Force to Publish.
                </p>
              )}
            </section>
          </>
        )}
        {message ? (
          <p
            role="status"
            className={
              message.ok
                ? "text-[var(--color-success)]"
                : "text-[var(--color-error)]"
            }
            data-testid="publish-message"
          >
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
