import { useQuery } from "@tanstack/react-query"
import { CheckCircle2Icon, FilterXIcon } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { statusOf } from "../../api/client.ts"
import type { DlsDenial, EventTrace } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { displayValue } from "../../lib/ejson.ts"

type Candidate = EventTrace["candidates"][number]

/** Why document level security kept the event from an observer whose own filter matched it. */
function DlsExplanation({ dls }: { readonly dls: DlsDenial }) {
  return (
    <section data-testid="dls-explanation">
      <h4 className="flex items-center gap-1.5 font-medium">
        <FilterXIcon className="size-4 text-warning" aria-hidden="true" />
        {t("realtime.trace.dls.title")}
      </h4>
      {"masked" in dls ? (
        <p className="mt-1 text-muted-foreground">{t("realtime.trace.dls.masked")}</p>
      ) : (
        <div className="mt-1 grid gap-2">
          <p>{t(`realtime.trace.dls.reasons.${dls.reason}`)}</p>
          {dls.responsible.length === 0 ? null : (
            <p>
              {t("realtime.trace.dls.responsible", {
                names: dls.responsible.map((name) => `"${name}"`).join(", "),
              })}
            </p>
          )}
          {dls.policies.length === 0 ? null : (
            <ul className="grid gap-1" aria-label={t("realtime.trace.dls.policies")}>
              {dls.policies.map((policy) => (
                <li
                  key={policy.name}
                  data-testid="dls-policy"
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="font-medium">{policy.name}</span>
                  <Badge variant="outline">{t(`realtime.trace.dls.kinds.${policy.kind}`)}</Badge>
                  <Badge variant={policy.matched ? "success" : "warning"}>
                    {policy.matched
                      ? t("realtime.trace.dls.matched")
                      : t("realtime.trace.dls.notMatched")}
                  </Badge>
                  {policy.issue === undefined ? null : (
                    <span className="text-muted-foreground">
                      {t("realtime.trace.dls.issue", {
                        variable: policy.issue.variable,
                        kind: policy.issue.kind,
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function CandidateCard({ candidate }: { readonly candidate: Candidate }) {
  return (
    <Card className="gap-3 py-4" data-testid="trace-candidate">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="font-mono text-sm">{candidate.observer}</CardTitle>
        <div className="flex gap-2">
          <Badge variant="outline">{candidate.type}</Badge>
          <Badge variant={candidate.outcome === "unmatched" ? "warning" : "success"}>
            {t(`realtime.trace.outcome.${candidate.outcome}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <section>
          <h4 className="flex items-center gap-1.5 font-medium">
            <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
            {t("realtime.trace.delivered")}
          </h4>
          {candidate.subscribers.length === 0 ? (
            <p className="text-muted-foreground">{t("realtime.trace.nobody")}</p>
          ) : (
            <ul className="mt-1 grid gap-0.5">
              {candidate.subscribers.map((subscriber) => (
                <li key={`${subscriber.sid}:${subscriber.sub}`}>
                  {t("realtime.trace.subscriber", {
                    subject: subscriber.subject,
                    sid: subscriber.sid,
                    sub: subscriber.sub,
                  })}
                </li>
              ))}
            </ul>
          )}
        </section>
        {candidate.dls === undefined ? null : <DlsExplanation dls={candidate.dls} />}
      </CardContent>
    </Card>
  )
}

/**
 * Answers "why did this client not get this event": the candidate observers, what each did with the event,
 * who received it and who document level security filtered out, with the policy responsible.
 */
export function TraceView({ eventId }: { readonly eventId: string | undefined }) {
  const api = useApi()
  const inputId = useId()
  const hintId = useId()
  const [draft, setDraft] = useState(eventId ?? "")
  const [current, setCurrent] = useState(eventId)
  useEffect(() => {
    setDraft(eventId ?? "")
    setCurrent(eventId)
  }, [eventId])
  const query = useQuery({
    queryKey: keys.trace(current ?? ""),
    queryFn: ({ signal }) => api.trace(current ?? "", signal),
    enabled: current !== undefined && current !== "",
  })
  return (
    <div className="grid gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setCurrent(draft.trim())
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>{t("realtime.trace.lookup")}</Label>
          <Input
            id={inputId}
            value={draft}
            aria-describedby={hintId}
            className="w-80 font-mono"
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={draft.trim() === ""}>
          {t("realtime.trace.show")}
        </Button>
        <p id={hintId} className="basis-full text-xs text-muted-foreground">
          {t("realtime.trace.lookupHint")}
        </p>
      </form>
      <div aria-live="polite">
        {current === undefined || current === "" ? (
          <EmptyState>{t("realtime.trace.choose")}</EmptyState>
        ) : query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          statusOf(query.error) === 404 ? (
            <EmptyState>{t("realtime.trace.gone")}</EmptyState>
          ) : (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          )
        ) : (
          <TraceResult trace={query.data} />
        )}
      </div>
    </div>
  )
}

function TraceResult({ trace }: { readonly trace: EventTrace }) {
  return (
    <div className="grid gap-4">
      <div>
        <h3 className="font-semibold">
          {t("realtime.trace.summary", {
            op: trace.op,
            collection: trace.coll,
            time:
              trace.wallTime === undefined || trace.wallTime === null
                ? t("common.unknown")
                : formatDateTime(trace.wallTime),
          })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("realtime.trace.document", { id: displayValue(trace.docId) })}
          {trace.policyVersion === undefined
            ? null
            : ` · ${t("realtime.trace.policyVersion", { version: trace.policyVersion })}`}
        </p>
      </div>
      <h4 className="text-sm font-medium">{t("realtime.trace.candidates")}</h4>
      {trace.candidates.length === 0 ? (
        <EmptyState>{t("realtime.trace.noCandidates")}</EmptyState>
      ) : (
        trace.candidates.map((candidate) => (
          <CandidateCard key={candidate.observer} candidate={candidate} />
        ))
      )}
    </div>
  )
}
