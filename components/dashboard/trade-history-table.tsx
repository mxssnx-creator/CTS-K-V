"use client"

import { useState, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import {
  History,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  TrendingUp,
  TrendingDown,
  Filter,
} from "lucide-react"

export interface TradeHistoryRow {
  id:          string
  symbol:      string
  direction:   "long" | "short"
  entryPrice:  number
  exitPrice:   number
  realizedPnl: number
  pnlPct:      number
  holdMinutes: number
  openedAt:    number
  closedAt:    number
  volumeUsd:   number
  pnlLabel:    string
  pnlPctLabel: string
  holdLabel:   string
}

interface TradeHistoryTableProps {
  trades: TradeHistoryRow[]
  limit?: number
}

type SortField = "closedAt" | "realizedPnl" | "pnlPct" | "symbol" | "holdMinutes" | "volumeUsd" | "entryPrice" | "exitPrice" | "direction"
type SortDir = "asc" | "desc"

export function TradeHistoryTable({ trades, limit = 100 }: TradeHistoryTableProps) {
  const [sortField, setSortField] = useState<SortField>("closedAt")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [search, setSearch] = useState("")
  const [directionFilter, setDirectionFilter] = useState<"all" | "long" | "short">("all")

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortField(field); setSortDir("desc") }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3.5 w-3.5 ml-1 opacity-40" />
    return sortDir === "asc"
      ? <ArrowUp className="h-3.5 w-3.5 ml-1 text-foreground" />
      : <ArrowDown className="h-3.5 w-3.5 ml-1 text-foreground" />
  }

  const filtered = useMemo(() => {
    let list = [...trades]
    if (directionFilter !== "all") list = list.filter((t) => t.direction === directionFilter)
    if (search.trim()) {
      const q = search.trim().toUpperCase()
      list = list.filter((t) => t.symbol.includes(q) || t.id.includes(q))
    }
    list.sort((a, b) => {
      let va: number, vb: number
      switch (sortField) {
        case "closedAt":    va = b.closedAt;    vb = a.closedAt; break   // reversed: newest first
        case "realizedPnl": va = a.realizedPnl; vb = b.realizedPnl; break
        case "pnlPct":      va = a.pnlPct;      vb = b.pnlPct; break
        case "symbol":      va = a.symbol.charCodeAt(0); vb = b.symbol.charCodeAt(0); break
        case "holdMinutes": va = a.holdMinutes; vb = b.holdMinutes; break
        case "volumeUsd":   va = a.volumeUsd;   vb = b.volumeUsd; break
        case "entryPrice":  va = a.entryPrice;  vb = b.entryPrice; break
        case "exitPrice":   va = a.exitPrice;   vb = b.exitPrice; break
        case "direction":   va = a.direction.charCodeAt(0); vb = b.direction.charCodeAt(0); break
      }
      return sortDir === "asc" ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1)
    })
    return list.slice(0, limit)
  }, [trades, sortField, sortDir, search, directionFilter, limit])

  const wins   = trades.filter((t) => t.realizedPnl > 0).length
  const losses = trades.filter((t) => t.realizedPnl < 0).length
  const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0)

  const fmtTime = (ts: number) =>
    ts > 0 ? new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4.5 w-4.5" />
          Trade History
          <Badge variant="outline" className="ml-1 text-xs">{trades.length} total</Badge>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground font-normal">
            <span className="text-green-600 font-medium">{wins}W</span>
            <span className="text-red-600 font-medium">{losses}L</span>
            <span className={totalPnl >= 0 ? "text-green-600" : "text-red-600"}>
              {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
            </span>
          </span>
        </CardTitle>
        {/* Filter bar */}
        <div className="flex items-center gap-2 mt-2">
          <div className="relative flex-1">
            <Input
              placeholder="Filter by symbol or trade ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm pl-8"
            />
            <Filter className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="flex gap-1">
            {(["all", "long", "short"] as const).map((d) => (
              <Button key={d} size="sm" variant={directionFilter === d ? "default" : "outline"} className="h-8 text-xs capitalize"
                onClick={() => setDirectionFilter(d)}>{d}</Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs" onClick={() => handleSort("closedAt")}>
                    Closed <SortIcon field="closedAt" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs">Symbol</TableHead>
                <TableHead className="text-xs">Direction</TableHead>
                <TableHead className="text-xs text-right">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs ml-auto" onClick={() => handleSort("entryPrice")}>
                    Entry <SortIcon field="entryPrice" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs text-right">Exit</TableHead>
                <TableHead className="text-xs">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs" onClick={() => handleSort("realizedPnl")}>
                    P&L <SortIcon field="realizedPnl" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs" onClick={() => handleSort("pnlPct")}>
                    P&L % <SortIcon field="pnlPct" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs" onClick={() => handleSort("holdMinutes")}>
                    Hold <SortIcon field="holdMinutes" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs text-right">
                  <Button variant="ghost" className="h-auto p-0 font-semibold text-xs ml-auto" onClick={() => handleSort("volumeUsd")}>
                    Volume <SortIcon field="volumeUsd" />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                    <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No closed trades yet
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((trade) => {
                  const isWin = trade.realizedPnl >= 0
                  return (
                    <TableRow key={trade.id} className="hover:bg-muted/30">
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtTime(trade.closedAt)}</TableCell>
                      <TableCell className="font-medium text-sm">{trade.symbol}</TableCell>
                      <TableCell>
                        <Badge variant={trade.direction === "long" ? "default" : "secondary"} className="text-[10px] h-5">
                          {trade.direction === "long" ? (
                            <><TrendingUp className="h-3 w-3 mr-0.5" />LONG</>
                          ) : (
                            <><TrendingDown className="h-3 w-3 mr-0.5" />SHORT</>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm">${trade.entryPrice.toFixed(4)}</TableCell>
                      <TableCell className="text-right text-sm">${trade.exitPrice.toFixed(4)}</TableCell>
                      <TableCell>
                        <span className={`text-sm font-semibold ${isWin ? "text-green-600" : "text-red-600"}`}>
                          {trade.pnlLabel}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={`text-sm font-medium ${isWin ? "text-green-600" : "text-red-600"}`}>
                          {trade.pnlPctLabel}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{trade.holdLabel}</TableCell>
                      <TableCell className="text-right text-sm">${trade.volumeUsd.toFixed(2)}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
        {filtered.length >= limit && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Showing {filtered.length} of {trades.length} closed trades (limit {limit})
          </p>
        )}
      </CardContent>
    </Card>
  )
}
