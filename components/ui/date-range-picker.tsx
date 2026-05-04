"use client";

// FILE: components/ui/date-range-picker.tsx
// Purpose: Custom date range picker. Sibling to the segmented range tabs.
// Layer: UI (shadcn Popover + Calendar + Button)
// Exports: DateRangePicker, type DateRange

import { useEffect, useMemo, useState } from "react";
import {
  endOfMonth,
  format,
  parse,
  startOfMonth,
  subDays,
  subMonths
} from "date-fns";
import { CalendarRange } from "lucide-react";
import type { DateRange as RdpRange } from "react-day-picker";

import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export type DateRange = { from: string; to: string };

// Quick presets pinned to the side of the calendar. Kept separate from the
// topbar's segmented tabs because those map to "preset RangeKey"s while these
// just seed the picker's own draft — the user still confirms with Apply.
const PRESETS: Array<{ label: string; getRange: () => RdpRange }> = [
  { label: "Last 7 days", getRange: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: "Last 28 days", getRange: () => ({ from: subDays(new Date(), 27), to: new Date() }) },
  { label: "Last 90 days", getRange: () => ({ from: subDays(new Date(), 89), to: new Date() }) },
  { label: "This month", getRange: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
  {
    label: "Last month",
    getRange: () => {
      const lastMonth = subMonths(new Date(), 1);
      return { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) };
    }
  },
  {
    label: "Year to date",
    getRange: () => ({ from: new Date(new Date().getFullYear(), 0, 1), to: new Date() })
  }
];

function parseISO(s: string) {
  return parse(s, "yyyy-MM-dd", new Date());
}

function formatISO(d: Date) {
  return format(d, "yyyy-MM-dd");
}

export function DateRangePicker({
  value,
  onChange,
  active
}: {
  value: DateRange | null;
  onChange: (range: DateRange) => void;
  // `active` is intentionally a separate prop from `value`: a custom range can
  // be remembered (value !== null) while a preset tab is the active range.
  // The trigger button only highlights and shows the date label when both
  // conditions hold.
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RdpRange | undefined>(() => initialDraft(value));
  const [viewMonth, setViewMonth] = useState<Date>(() => initialView(value));

  // Re-seed the draft and reset the visible month every time the popover
  // opens so the user starts from the currently-applied range, not whatever
  // they were dragging the last time they cancelled.
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(value));
    setViewMonth(initialView(value));
  }, [open, value]);

  function applyDraft() {
    if (!draft?.from || !draft?.to) return;
    onChange({ from: formatISO(draft.from), to: formatISO(draft.to) });
    setOpen(false);
  }

  function applyPreset(getRange: () => RdpRange) {
    const next = getRange();
    setDraft(next);
    if (next.to) setViewMonth(next.to);
  }

  const triggerLabel = useMemo(() => formatTriggerLabel(active, value), [active, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="topbar-toggle date-range-trigger"
          data-active={active}
          aria-label={active ? `Custom range: ${triggerLabel}` : "Pick a custom date range"}
          title="Pick a custom date range"
        >
          <CalendarRange size={12} strokeWidth={1.8} />
          <span className="topbar-toggle-label">{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="date-range-popover w-auto p-0"
      >
        <div className="date-range-head">
          <div className="date-range-eyebrow">CUSTOM RANGE</div>
          <div className="date-range-summary">
            <div className="date-range-summary-cell" data-empty={!draft?.from}>
              <span className="date-range-summary-label">From</span>
              <span className="date-range-summary-value">
                {draft?.from ? format(draft.from, "MMM d, yyyy") : "—"}
              </span>
            </div>
            <span className="date-range-summary-arrow" aria-hidden>
              →
            </span>
            <div className="date-range-summary-cell" data-empty={!draft?.to}>
              <span className="date-range-summary-label">To</span>
              <span className="date-range-summary-value">
                {draft?.to ? format(draft.to, "MMM d, yyyy") : "—"}
              </span>
            </div>
          </div>
        </div>

        <div className="date-range-body">
          <div className="date-range-presets" role="group" aria-label="Quick ranges">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start font-normal"
                onClick={() => applyPreset(preset.getRange)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            selected={draft}
            onSelect={setDraft}
            month={viewMonth}
            onMonthChange={setViewMonth}
            weekStartsOn={1}
            numberOfMonths={1}
            captionLayout="dropdown"
          />
        </div>

        <div className="date-range-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={applyDraft}
            disabled={!draft?.from || !draft?.to}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function initialDraft(value: DateRange | null): RdpRange | undefined {
  if (!value) return undefined;
  return { from: parseISO(value.from), to: parseISO(value.to) };
}

function initialView(value: DateRange | null): Date {
  // Anchor to the *end* date so a long custom range ("Jan 1 – today") opens
  // on the most recent month, not the start where there's nothing to look at.
  return value ? parseISO(value.to) : new Date();
}

function formatTriggerLabel(active: boolean, value: DateRange | null) {
  if (!active || !value) return "Custom";
  const from = parseISO(value.from);
  const to = parseISO(value.to);
  if (from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth()) {
    return `${format(from, "MMM d")}–${format(to, "d")}`;
  }
  if (from.getFullYear() === to.getFullYear()) {
    return `${format(from, "MMM d")} – ${format(to, "MMM d")}`;
  }
  return `${format(from, "MMM d, yy")} – ${format(to, "MMM d, yy")}`;
}
