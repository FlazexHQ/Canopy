import { useState } from "react"
import { PageHeader } from "../../components/states.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { ConnectionsView, ObserversView } from "./inspector.tsx"
import { RealtimeOverview } from "./stats.tsx"
import { TailView } from "./tail.tsx"
import { TraceView } from "./trace.tsx"
import { useTail } from "./use-tail.ts"

const TABS = ["overview", "tail", "connections", "observers", "trace"] as const
type Tab = (typeof TABS)[number]

/** The realtime inspector: counts and lag, the event tail, connections, observers and event traces. */
export function RealtimePage() {
  const [tab, setTab] = useState<Tab>("overview")
  const [traced, setTraced] = useState<string | undefined>(undefined)
  const tail = useTail()
  return (
    <>
      <PageHeader title={t("realtime.title")} description={t("realtime.description")} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="grid gap-4">
        <TabsList aria-label={t("realtime.tabs.label")}>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`realtime.tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <RealtimeOverview tailRate={tail.ratePerSecond} />
        </TabsContent>
        <TabsContent value="tail">
          <TailView
            tail={tail}
            onTrace={(id) => {
              setTraced(id)
              setTab("trace")
            }}
          />
        </TabsContent>
        <TabsContent value="connections">
          <ConnectionsView />
        </TabsContent>
        <TabsContent value="observers">
          <ObserversView />
        </TabsContent>
        <TabsContent value="trace">
          <TraceView eventId={traced} />
        </TabsContent>
      </Tabs>
    </>
  )
}
