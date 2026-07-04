import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetProtocolSummary, useListTransactions, useListPools, getPoolStats } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface HistoryPoint {
  timestamp: string;
  tvl: number;
  volume: number;
  fees: number;
}

const TIME_RANGES = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "All", days: null },
] as const;

type TimeRangeLabel = (typeof TIME_RANGES)[number]["label"];

function useProtocolHistory(poolIds: string[] | undefined) {
  return useQuery({
    queryKey: ["protocol-history", poolIds],
    queryFn: async (): Promise<HistoryPoint[]> => {
      const allStats = await Promise.all((poolIds ?? []).map((id) => getPoolStats(id)));
      const byTimestamp = new Map<string, HistoryPoint>();
      for (const stats of allStats) {
        for (const point of stats.data) {
          const existing = byTimestamp.get(point.timestamp);
          if (existing) {
            existing.tvl += point.tvl;
            existing.volume += point.volume;
            existing.fees += point.fees;
          } else {
            byTimestamp.set(point.timestamp, { timestamp: point.timestamp, tvl: point.tvl, volume: point.volume, fees: point.fees });
          }
        }
      }
      return Array.from(byTimestamp.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },
    enabled: !!poolIds && poolIds.length > 0,
  });
}

export default function AnalyticsPage() {
  const { data: summary, isLoading: summaryLoading } = useGetProtocolSummary();
  const { data: transactions, isLoading: txLoading } = useListTransactions({ limit: 20 });
  const { data: pools, isLoading: poolsLoading } = useListPools({});
  const poolIds = pools?.map((p) => p.id);
  const { data: history, isLoading: historyLoading } = useProtocolHistory(poolIds);
  const [range, setRange] = useState<TimeRangeLabel>("30D");

  const loadingCharts = poolsLoading || historyLoading;
  const tvlChange = summary?.tvlChange24h ?? 0;
  const volumeChange = summary?.volumeChange24h ?? 0;

  const filteredHistory = useMemo(() => {
    if (!history) return history;
    const days = TIME_RANGES.find((r) => r.label === range)?.days;
    if (days == null) return history;
    return history.slice(-days);
  }, [history, range]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Protocol Analytics</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">Total TVL</div>
          {summaryLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
            <>
              <div className="text-xl sm:text-2xl font-mono font-bold">${summary?.totalTvl.toLocaleString()}</div>
              <ChangeBadge value={tvlChange} />
            </>
          )}
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">24h Volume</div>
          {summaryLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
            <>
              <div className="text-xl sm:text-2xl font-mono font-bold">${summary?.totalVolume24h.toLocaleString()}</div>
              <ChangeBadge value={volumeChange} />
            </>
          )}
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">24h Fees</div>
          {summaryLoading ? <Skeleton className="h-8 w-24 mt-1" /> : <div className="text-xl sm:text-2xl font-mono font-bold">${summary?.totalFees24h.toLocaleString()}</div>}
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">Total Pools</div>
          {summaryLoading ? <Skeleton className="h-8 w-24 mt-1" /> : <div className="text-xl sm:text-2xl font-mono font-bold">{summary?.totalPools}</div>}
        </Card>
      </div>

      <div className="flex items-center justify-end">
        <div className="inline-flex items-center rounded-lg border border-border bg-card p-1 gap-1">
          {TIME_RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setRange(r.label)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                range === r.label ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`button-range-${r.label.toLowerCase()}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6 bg-card border-border">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">TVL Over Time</h3>
          <div className="h-[280px] w-full">
            {loadingCharts ? (
              <Skeleton className="w-full h-full" />
            ) : filteredHistory && filteredHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={filteredHistory}>
                  <defs>
                    <linearGradient id="tvlGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(val) => new Date(val).toLocaleDateString("en", { month: "short", day: "numeric" })}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(val) => `$${abbreviate(val)}`}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8 }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    formatter={(value: number) => [`$${value.toLocaleString("en", { maximumFractionDigits: 0 })}`, "TVL"]}
                    labelFormatter={(val) => new Date(val).toLocaleString()}
                  />
                  <Area type="monotone" dataKey="tvl" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#tvlGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No historical data available</div>
            )}
          </div>
        </Card>

        <Card className="p-6 bg-card border-border">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Volume Over Time</h3>
          <div className="h-[280px] w-full">
            {loadingCharts ? (
              <Skeleton className="w-full h-full" />
            ) : filteredHistory && filteredHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={filteredHistory}>
                  <defs>
                    <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(val) => new Date(val).toLocaleDateString("en", { month: "short", day: "numeric" })}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(val) => `$${abbreviate(val)}`}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8 }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    formatter={(value: number) => [`$${value.toLocaleString("en", { maximumFractionDigits: 0 })}`, "Volume"]}
                    labelFormatter={(val) => new Date(val).toLocaleString()}
                  />
                  <Area type="monotone" dataKey="volume" stroke="hsl(var(--accent))" strokeWidth={2} fill="url(#volumeGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No historical data available</div>
            )}
          </div>
        </Card>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="font-bold">Recent Transactions</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Value</th>
                <th className="px-4 py-2 text-left font-medium">Time</th>
                <th className="px-4 py-2 text-right font-medium">Tx Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {txLoading ? (
                <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
              ) : (
                transactions?.map(tx => (
                  <tr key={tx.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 capitalize whitespace-nowrap">{tx.type.replace('_', ' ')}</td>
                    <td className="px-4 py-3 font-mono whitespace-nowrap">${tx.valueUsd?.toLocaleString()}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{new Date(tx.timestamp).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-mono text-primary whitespace-nowrap">{tx.txHash.substring(0, 8)}...</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ChangeBadge({ value }: { value: number }) {
  const isUp = value >= 0;
  return (
    <div className={`text-xs font-mono flex items-center gap-0.5 mt-0.5 ${isUp ? "text-green-400" : "text-red-400"}`}>
      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {Math.abs(value).toFixed(2)}%
    </div>
  );
}

function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en", { maximumFractionDigits: 0 });
}
