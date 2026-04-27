"use client";

// FILE: components/net-calculator-sheet.tsx
// Purpose: Live "what's left in your pocket after taxes & RevenueCat" estimator
//          tuned for an Italian forfettario sviluppatore software (67%).
// Layer: Client component
// Exports: NetCalculatorSheet, NetCalculatorTrigger, NET_CALCULATOR_DEFAULTS, NetCalculatorState
// Depends on: lib/tax-calculator, components/ui/sheet, components/ui/switch

import { useEffect, useMemo, useState } from "react";
import { Calculator, Wallet } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_EXTRAS,
  DEFAULT_INPS_FIXED,
  TAX_CONSTANTS,
  computeTaxBreakdown,
  type AppleCutTier,
  type ExtrasInputs,
  type ForfettarioRegime,
  type InpsCoverage,
  type InpsMode,
  type TaxBreakdown
} from "@/lib/tax-calculator";

// ─── Public surface ──────────────────────────────────────────

export type NetCalculatorState = {
  regime: ForfettarioRegime;
  // INPS configurabile in due modi: importo fisso annuo (default, perché
  // gli utenti tipicamente "vedono" l'INPS come una spesa fissa) oppure
  // percentuale Gestione Separata sull'imponibile.
  inpsMode: InpsMode;
  inpsFixed: number;
  inps: InpsCoverage;
  appleTier: AppleCutTier;
  extras: ExtrasInputs;
};

export const NET_CALCULATOR_DEFAULTS: NetCalculatorState = {
  regime: "regime",
  inpsMode: "fixed",
  inpsFixed: DEFAULT_INPS_FIXED,
  inps: "full",
  appleTier: "sbp",
  extras: DEFAULT_EXTRAS
};

// ─── Trigger button (lives in TopBar) ────────────────────────

// Standalone button styled to match the existing topbar controls. Splits the
// trigger from the Sheet itself so the parent owns the open/close state and
// can mount the Sheet portal once at the dashboard level (cleaner than
// re-mounting it inside every TopBar render).
export function NetCalculatorTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="topbar-toggle calc-trigger"
      onClick={onClick}
      aria-label="Apri calcolatore netto in tasca"
      title="Calcolo netto in tasca (forfettario IT)"
    >
      <Wallet size={13} strokeWidth={1.8} aria-hidden />
      <span className="topbar-toggle-label">NET</span>
    </button>
  );
}

// ─── The Sheet itself ────────────────────────────────────────

export function NetCalculatorSheet({
  open,
  onOpenChange,
  state,
  onStateChange,
  grossPeriod,
  periodDays,
  periodLabel,
  currency
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  state: NetCalculatorState;
  onStateChange: (next: NetCalculatorState) => void;
  // Gross revenue *for the selected period* in the chart's currency. Caller
  // is expected to pass the un-cut (gross) value, since the calculator
  // applies the Apple commission internally based on the chosen tier.
  grossPeriod: number | null;
  periodDays: number;
  periodLabel: string;
  currency: string;
}) {
  // Recompute on any input change. The calculator is pure → cheap to call,
  // but useMemo keeps the breakdown rows stable for React DOM diffing.
  const breakdown = useMemo<TaxBreakdown | null>(() => {
    if (grossPeriod === null || grossPeriod <= 0 || periodDays <= 0) return null;
    return computeTaxBreakdown({
      grossPeriod,
      periodDays,
      appleCut: state.appleTier,
      regime: state.regime,
      inpsMode: state.inpsMode,
      inps: state.inps,
      inpsFixed: state.inpsFixed,
      extras: state.extras
    });
  }, [grossPeriod, periodDays, state]);

  function patch<K extends keyof NetCalculatorState>(key: K, value: NetCalculatorState[K]) {
    onStateChange({ ...state, [key]: value });
  }

  function patchExtra<K extends keyof ExtrasInputs>(key: K, next: ExtrasInputs[K]) {
    onStateChange({ ...state, extras: { ...state.extras, [key]: next } });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="calc-sheet" side="right">
        <SheetHeader className="calc-header">
          <div className="calc-eyebrow">
            <Calculator size={11} strokeWidth={2} aria-hidden />
            <span>NETTO IN TASCA</span>
          </div>
          <SheetTitle className="calc-title">Quanto ti resta davvero</SheetTitle>
          <SheetDescription className="calc-sub">
            Stima per regime forfettario italiano (coefficiente 67%, sviluppo
            software). Numeri annualizzati in base al periodo selezionato sulla
            dashboard.
          </SheetDescription>
        </SheetHeader>

        <div className="calc-body">
          <NetHeadline breakdown={breakdown} currency={currency} />

          <BreakdownTable breakdown={breakdown} currency={currency} state={state} />

          <SettingsBlock state={state} patch={patch} />

          <ExtrasBlock extras={state.extras} patchExtra={patchExtra} currency={currency} />

          <ContextNote periodLabel={periodLabel} grossPeriod={grossPeriod} currency={currency} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Headline (big number) ───────────────────────────────────

function NetHeadline({ breakdown, currency }: { breakdown: TaxBreakdown | null; currency: string }) {
  return (
    <section className="calc-headline" aria-live="polite">
      <span className="calc-headline-label">Stimato netto annuo</span>
      <span className="calc-headline-value">
        {breakdown ? formatCurrencyCompact(breakdown.net, currency) : "—"}
      </span>
      <span className="calc-headline-sub">
        {breakdown ? `≈ ${formatCurrencyCompact(breakdown.netMonthly, currency)} / mese` : "Nessun dato di periodo"}
      </span>
    </section>
  );
}

// ─── Waterfall table ─────────────────────────────────────────

// Top-down financial waterfall: every row is either subtotal/deduction.
// Renders a row per active extra so the user immediately sees where each
// euro lands without expanding anything.
function BreakdownTable({
  breakdown,
  currency,
  state
}: {
  breakdown: TaxBreakdown | null;
  currency: string;
  state: NetCalculatorState;
}) {
  const z = breakdown ?? makeZeroBreakdown();

  type Row = {
    label: string;
    detail?: string;
    value: number;
    kind: "subtotal" | "deduct" | "neutral" | "net";
  };

  const baseRows: Row[] = [
    { label: "Lordo annualizzato", detail: "MTR proiettato a 12 mesi", value: z.annualGross, kind: "subtotal" },
    { label: "Commissione Apple", detail: appleDetail(state.appleTier), value: -z.appleCommission, kind: "deduct" },
    { label: "Bonifici Apple", detail: "= ricavi forfettari", value: z.appleProceeds, kind: "subtotal" },
    { label: "Spese forfettarie 33%", detail: "deduzione automatica", value: -z.forfettariCosts, kind: "neutral" },
    { label: "Imponibile fiscale", detail: "= 67% dei ricavi", value: z.imponibile, kind: "subtotal" },
    { label: "Imposta sostitutiva", detail: regimeDetail(state.regime), value: -z.impostaSostitutiva, kind: "deduct" },
    { label: "INPS", detail: inpsDetail(state), value: -z.inpsContributi, kind: "deduct" },
    { label: "Fee RevenueCat", detail: "1% MTR oltre 2.500/mese", value: -z.revenueCatFee, kind: "deduct" },
    { label: "IVA reverse charge 22%", detail: "non recuperabile in forfettario", value: -z.ivaReverseCharge, kind: "deduct" }
  ];

  // Solo gli extras attivi finiscono nella tabella, così la lista resta
  // corta quando l'utente disattiva tutto.
  const extraRows: Row[] = [];
  if (state.extras.bollo.enabled) {
    extraRows.push({ label: "Bollo fatture", detail: "€2 per fattura > 77,47", value: -z.extras.bollo, kind: "deduct" });
  }
  if (state.extras.commercialista.enabled) {
    extraRows.push({ label: "Commercialista", detail: "compenso annuo", value: -z.extras.commercialista, kind: "deduct" });
  }
  if (state.extras.pecFirma.enabled) {
    extraRows.push({ label: "PEC + firma digitale", detail: "rinnovo annuo", value: -z.extras.pecFirma, kind: "deduct" });
  }
  if (state.extras.cciaa.enabled) {
    extraRows.push({ label: "Diritto CCIAA", detail: "se iscritto come artigiano", value: -z.extras.cciaa, kind: "deduct" });
  }

  const netRow: Row = { label: "Netto in tasca", detail: "annuo", value: z.net, kind: "net" };

  const rows: Row[] = [...baseRows, ...extraRows, netRow];

  return (
    <section className="calc-table" aria-label="Breakdown annuale">
      {rows.map((row) => (
        <div className="calc-row" data-kind={row.kind} key={row.label}>
          <div className="calc-row-text">
            <span className="calc-row-label">{row.label}</span>
            {row.detail && <span className="calc-row-detail">{row.detail}</span>}
          </div>
          <span className="calc-row-value">
            {breakdown ? signedCurrency(row.value, currency, row.kind) : "—"}
          </span>
        </div>
      ))}
    </section>
  );
}

// ─── Settings ────────────────────────────────────────────────

function SettingsBlock({
  state,
  patch
}: {
  state: NetCalculatorState;
  patch: <K extends keyof NetCalculatorState>(key: K, value: NetCalculatorState[K]) => void;
}) {
  return (
    <section className="calc-settings" aria-label="Parametri fiscali">
      <h3 className="calc-settings-title">Parametri</h3>

      <SegmentedField<ForfettarioRegime>
        label="Regime"
        hint={`${(TAX_CONSTANTS.REGIME_RATES.startup * 100).toFixed(0)}% start-up vs ${(TAX_CONSTANTS.REGIME_RATES.regime * 100).toFixed(0)}% a regime`}
        value={state.regime}
        onChange={(v) => patch("regime", v)}
        options={[
          { value: "startup", label: "Start-up", sub: "5%" },
          { value: "regime", label: "A regime", sub: "15%" }
        ]}
      />

      <InpsField
        mode={state.inpsMode}
        coverage={state.inps}
        fixed={state.inpsFixed}
        onModeChange={(v) => patch("inpsMode", v)}
        onCoverageChange={(v) => patch("inps", v)}
        onFixedChange={(v) => patch("inpsFixed", v)}
      />

      <SegmentedField<AppleCutTier>
        label="Commissione Apple"
        hint="Small Business sotto $1M/anno (incl. abbonamenti dal day one)"
        value={state.appleTier}
        onChange={(v) => patch("appleTier", v)}
        options={[
          { value: "sbp", label: "Small Business", sub: "15%" },
          { value: "standard", label: "Standard", sub: "30%" }
        ]}
      />
    </section>
  );
}

// INPS-specific control: the choice of mode (fixed / percent) determines
// whether the user sees a number input or the standard coverage radio.
// Lives as its own component because the layout is bespoke compared to the
// generic SegmentedField — there's a number input or a sub-segmented row
// that swaps based on the top-level mode.
function InpsField({
  mode,
  coverage,
  fixed,
  onModeChange,
  onCoverageChange,
  onFixedChange
}: {
  mode: InpsMode;
  coverage: InpsCoverage;
  fixed: number;
  onModeChange: (next: InpsMode) => void;
  onCoverageChange: (next: InpsCoverage) => void;
  onFixedChange: (next: number) => void;
}) {
  return (
    <div className="calc-field">
      <div className="calc-field-text">
        <span className="calc-field-label">INPS</span>
        <span className="calc-field-hint">
          fisso annuo (utile per Gestione Artigiani / stime), o % Gestione Separata
        </span>
      </div>

      <div className="calc-segments" role="radiogroup" aria-label="Modalità INPS">
        {([
          { value: "fixed", label: "Fisso", sub: "€/anno" },
          { value: "percent", label: "Percentuale", sub: "Gestione Separata" }
        ] as const).map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={mode === opt.value}
            data-active={mode === opt.value}
            className="calc-segment"
            onClick={() => onModeChange(opt.value)}
          >
            <span className="calc-segment-label">{opt.label}</span>
            <span className="calc-segment-sub">{opt.sub}</span>
          </button>
        ))}
      </div>

      {mode === "fixed" ? (
        <NumberInput
          ariaLabel="Importo INPS fisso annuo (EUR)"
          value={fixed}
          onChange={onFixedChange}
          step={100}
          min={0}
          suffix="€/anno"
          hint="default 4.000 — copre il minimale Gestione Artigiani ridotto -35% per forfettari (~€2.939) o un imponibile Gestione Separata ~€15k"
        />
      ) : (
        <div className="calc-segments calc-segments--secondary" role="radiogroup" aria-label="Copertura INPS">
          {([
            { value: "full", label: "Senza altra copertura", sub: "26,07%" },
            { value: "partial", label: "Con altra copertura", sub: "24%" }
          ] as const).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={coverage === opt.value}
              data-active={coverage === opt.value}
              className="calc-segment"
              onClick={() => onCoverageChange(opt.value)}
            >
              <span className="calc-segment-label">{opt.label}</span>
              <span className="calc-segment-sub">{opt.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Generic 2-option segmented control, styled to match the existing topbar tabs.
function SegmentedField<T extends string>({
  label,
  hint,
  value,
  onChange,
  options
}: {
  label: string;
  hint?: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string; sub?: string }>;
}) {
  return (
    <div className="calc-field">
      <div className="calc-field-text">
        <span className="calc-field-label">{label}</span>
        {hint && <span className="calc-field-hint">{hint}</span>}
      </div>
      <div className="calc-segments" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            data-active={value === opt.value}
            className="calc-segment"
            onClick={() => onChange(opt.value)}
          >
            <span className="calc-segment-label">{opt.label}</span>
            {opt.sub && <span className="calc-segment-sub">{opt.sub}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Extras (bollo, commercialista, PEC, CCIAA) ──────────────

function ExtrasBlock({
  extras,
  patchExtra,
  currency
}: {
  extras: ExtrasInputs;
  patchExtra: <K extends keyof ExtrasInputs>(key: K, next: ExtrasInputs[K]) => void;
  currency: string;
}) {
  type ExtraDef = {
    key: keyof ExtrasInputs;
    label: string;
    hint: string;
  };

  const defs: ExtraDef[] = [
    { key: "bollo", label: "Bollo fatture", hint: "€2 per fattura > 77,47 (12/anno per Apple)" },
    { key: "commercialista", label: "Commercialista", hint: "forfait annuo (range 600–1.500)" },
    { key: "pecFirma", label: "PEC + firma digitale", hint: "PEC + firma + SDI" },
    { key: "cciaa", label: "Diritto annuale CCIAA", hint: "solo se iscritto come artigiano" }
  ];

  return (
    <section className="calc-settings" aria-label="Costi extra opzionali">
      <h3 className="calc-settings-title">Costi extra annui</h3>

      <div className="calc-extras">
        {defs.map((def) => {
          const item = extras[def.key];
          return (
            <ExtraRow
              key={def.key}
              label={def.label}
              hint={def.hint}
              enabled={item.enabled}
              amount={item.amount}
              currency={currency}
              onToggle={(next) => patchExtra(def.key, { ...item, enabled: next })}
              onAmountChange={(next) => patchExtra(def.key, { ...item, amount: next })}
            />
          );
        })}
      </div>
    </section>
  );
}

function ExtraRow({
  label,
  hint,
  enabled,
  amount,
  currency,
  onToggle,
  onAmountChange
}: {
  label: string;
  hint: string;
  enabled: boolean;
  amount: number;
  currency: string;
  onToggle: (next: boolean) => void;
  onAmountChange: (next: number) => void;
}) {
  return (
    <div className="calc-extra-row" data-enabled={enabled}>
      <Switch
        size="sm"
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={`Attiva ${label}`}
      />
      <div className="calc-extra-text">
        <span className="calc-extra-label">{label}</span>
        <span className="calc-extra-hint">{hint}</span>
      </div>
      <NumberInput
        ariaLabel={`Importo ${label} annuo`}
        value={amount}
        onChange={onAmountChange}
        step={10}
        min={0}
        suffix={currencySymbol(currency) + "/anno"}
        compact
        disabled={!enabled}
      />
    </div>
  );
}

// Minimal styled number input. Editable via keyboard; numeric-only, blurs
// to commit so the parent state isn't thrashed on every keystroke.
function NumberInput({
  value,
  onChange,
  ariaLabel,
  hint,
  step = 1,
  min = 0,
  suffix,
  compact = false,
  disabled = false
}: {
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
  hint?: string;
  step?: number;
  min?: number;
  suffix?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  // Mirror the parent value into local state so the user can type freely
  // (including transient empty / partial values) without each keystroke
  // round-tripping through the global onStateChange flow.
  const [draft, setDraft] = useState(String(value));

  // Keep the input in sync if the parent updates `value` from outside (e.g.
  // localStorage hydration, default reset). Skip when the input is currently
  // focused — typing a partial number shouldn't be wiped by an upstream tick.
  useEffect(() => {
    setDraft((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);

  function commit() {
    const parsed = Number(draft.replace(",", "."));
    const next = Number.isFinite(parsed) ? Math.max(min, parsed) : min;
    setDraft(String(next));
    if (next !== value) onChange(next);
  }

  return (
    <div className="calc-num-shell">
      <div
        className={
          "calc-num" + (compact ? " calc-num--compact" : "") + (disabled ? " calc-num--disabled" : "")
        }
      >
        <input
          type="text"
          inputMode="decimal"
          aria-label={ariaLabel}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9.,]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.max(min, value + step);
              setDraft(String(next));
              onChange(next);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = Math.max(min, value - step);
              setDraft(String(next));
              onChange(next);
            }
          }}
        />
        {suffix && <span className="calc-num-suffix">{suffix}</span>}
      </div>
      {hint && <span className="calc-num-hint">{hint}</span>}
    </div>
  );
}

// ─── Footer note ─────────────────────────────────────────────

function ContextNote({
  periodLabel,
  grossPeriod,
  currency
}: {
  periodLabel: string;
  grossPeriod: number | null;
  currency: string;
}) {
  return (
    <p className="calc-note">
      Base di calcolo: lordo del periodo&nbsp;
      <span className="calc-note-strong">{periodLabel.toLowerCase()}</span> ={" "}
      <span className="calc-note-strong">
        {grossPeriod !== null ? formatCurrencyCompact(grossPeriod, currency) : "—"}
      </span>
      , annualizzato moltiplicando per 365 / giorni del periodo. La soglia
      RevenueCat è in USD ma applicata anche in {currency} (errore sub-percentuale al cambio
      attuale). Stima informativa, non sostituisce il commercialista.
    </p>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function makeZeroBreakdown(): TaxBreakdown {
  return {
    annualGross: 0,
    appleCommission: 0,
    appleProceeds: 0,
    forfettariCosts: 0,
    imponibile: 0,
    impostaSostitutiva: 0,
    inpsContributi: 0,
    revenueCatFee: 0,
    ivaReverseCharge: 0,
    extrasTotal: 0,
    extras: { bollo: 0, commercialista: 0, pecFirma: 0, cciaa: 0 },
    net: 0,
    netMonthly: 0
  };
}

function regimeDetail(regime: ForfettarioRegime) {
  return regime === "startup" ? "5% start-up su imponibile" : "15% su imponibile";
}

function appleDetail(tier: AppleCutTier) {
  return tier === "sbp" ? "Small Business 15%" : "Standard 30%";
}

function inpsDetail(state: NetCalculatorState) {
  if (state.inpsMode === "fixed") return "importo fisso annuo";
  return state.inps === "full"
    ? "26,07% Gestione Separata"
    : "24% (con altra copertura)";
}

function currencySymbol(currency: string) {
  if (currency === "EUR") return "€";
  if (currency === "USD") return "$";
  return currency;
}

function formatCurrencyCompact(value: number, currency: string) {
  const abs = Math.abs(value);
  const fractionDigits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0
  }).format(value);
}

// Renders deductions with an explicit minus sign (so the eye doesn't mistake
// "$-9,000" for a positive). Subtotals stay unsigned, the net is shown plain.
function signedCurrency(value: number, currency: string, kind: "subtotal" | "deduct" | "neutral" | "net") {
  if (kind === "deduct" || kind === "neutral") {
    const abs = Math.abs(value);
    if (abs === 0) return formatCurrencyCompact(0, currency);
    return `− ${formatCurrencyCompact(abs, currency)}`;
  }
  return formatCurrencyCompact(value, currency);
}
